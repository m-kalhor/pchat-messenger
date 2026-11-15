#!/bin/bash
# Sepan 1.16.0 deploy (server only): sms.ir removed, SMS providers pluggable (src/sms/), Arta Payamak configured.
# code.tgz = any tar.gz of this branch with one top folder (git archive or the GitHub tarball); arta.json is never in git.
# $STAGE/arta.json (token, from, pattern, param) is written into the settings while the service is stopped,
# then deleted. Replaces /opt/messenger/app with the new src, keeps data/certs/config. Backup first, verify,
# roll back on failure.
set -uo pipefail
STAGE=/root/sepan-1.16.0
APP=/opt/messenger/app
DATA=/opt/messenger/data
IP=193.151.148.119

echo "== pre-checks"
cd $STAGE || { echo "ABORT: no $STAGE"; exit 1; }
rm -rf $STAGE/src && tar xzf code.tgz --strip-components=2 --wildcards '*/server/src' || { echo "ABORT: untar"; exit 1; }
printf '%s\n' "2ee57f31d0f191aa5c742fdcebadd05e  src/sms/index.js" "6910f252b5c10313fd9cede4ba85a8fa  src/sms/artapayamak.js" "28cd7956e053ec7db3ef3f91519ec292  src/admin.html" "e5fa670c21565c967e024591eecba196  src/auth.js" | md5sum -c - || { echo "ABORT: checksum"; exit 1; }
grep -q "const VERSION = '1.16.0';" src/web/app.mjs || { echo "ABORT: not the 1.16.0 source"; exit 1; }
for f in src/sms/index.js src/sms/artapayamak.js src/auth.js src/server.js src/adminpanel.js; do node --check $f || { echo "ABORT: syntax $f"; exit 1; }; done
[ -f arta.json ] || { echo "ABORT: no arta.json"; exit 1; }
CFG=$(tr -d '\r\n' < arta.json)
echo "$CFG" | grep -q '"token"' && echo "$CFG" | grep -q '"pattern"' || { echo "ABORT: arta.json incomplete"; exit 1; }
echo "$CFG" | grep -q "'" && { echo "ABORT: quote in arta.json"; exit 1; }
USERS_BEFORE=$(msgadmin list | wc -l)
PACKS_BEFORE=$(sqlite3 $DATA/messenger.db "SELECT group_concat(n,'+') FROM (SELECT COUNT(*) n FROM stickers GROUP BY pack_id ORDER BY n DESC)")
MSGS_BEFORE=$(sqlite3 $DATA/messenger.db "SELECT COUNT(*) FROM messages")
echo "users: $USERS_BEFORE  packs: $PACKS_BEFORE  messages: $MSGS_BEFORE  running: $(grep -m1 'const VERSION' $APP/web/app.mjs)"
echo "old sms settings: $(sqlite3 $DATA/messenger.db "SELECT group_concat(key,',') FROM settings WHERE key LIKE 'sms%' OR key='open_signup'")"

echo "== backup"
TS=$(date +%Y%m%d-%H%M%S)
SAFE=/root/messenger-backup-$TS
mkdir -p "$SAFE"
systemctl stop messenger
cp -a $APP "$SAFE/app"
cp -a $DATA/messenger.db* "$SAFE/" 2>/dev/null || true
echo "backup: $SAFE"

echo "== install"
rm -rf $APP/web $APP/sms
cp -r $STAGE/src/. $APP/
chown -R msg:msg $APP 2>/dev/null || true
sqlite3 $DATA/messenger.db "INSERT INTO settings(key,value) VALUES('sms_provider','artapayamak') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
INSERT INTO settings(key,value) VALUES('sms_cfg_artapayamak','$CFG') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
INSERT INTO settings(key,value) VALUES('sms_enabled','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value;" || echo "WARN: settings not written"
rm -f $STAGE/arta.json
systemctl start messenger
sleep 6

echo "== verify"
FAIL=0
chk() { if [ "$2" = ok ]; then echo "PASS  $1"; else echo "FAIL  $1  ($3)"; FAIL=1; fi; }
S=$(systemctl is-active messenger); chk "messenger active" "$([ "$S" = active ] && echo ok)" "$S"
H=$(curl -sk https://127.0.0.1:8443/api/health); chk "health 8443" "$(echo "$H" | grep -qi ok && echo ok)" "$H"
W="curl -s --cacert /opt/messenger/ca/ca.pem --resolve $IP:443:127.0.0.1 https://$IP"
H2=$($W/api/health); chk "web health 443" "$(echo "$H2" | grep -qi ok && echo ok)" "$H2"
$W/app.mjs -o /tmp/sepan-app.mjs
chk "/app.mjs VERSION 1.16.0" "$(grep -q "const VERSION = '1.16.0'" /tmp/sepan-app.mjs && echo ok)" "$(grep -m1 'const VERSION' /tmp/sepan-app.mjs)"
A=$(curl -sk -o /tmp/sepan-admin.html -w '%{http_code}' https://127.0.0.1:8444/)
chk "admin panel has provider select" "$([ "$A" = 200 ] && grep -q smsVals /tmp/sepan-admin.html && ! grep -q 'app.sms.ir' /tmp/sepan-admin.html && echo ok)" "http $A"
OLD=$(sqlite3 $DATA/messenger.db "SELECT COUNT(*) FROM settings WHERE key IN ('sms_api_key','sms_template_id','sms_param')")
chk "sms.ir settings removed" "$([ "$OLD" = 0 ] && echo ok)" "$OLD left"
C=$(curl -sk https://127.0.0.1:8443/api/auth/config); chk "login offers SMS ($C)" "$(echo "$C" | grep -q '"sms":true' && echo ok)" "$C"
CR=$(cd $APP && sudo -u msg env DATA_DIR=$DATA node -e "require('./sms').credit().then(c=>console.log('CREDIT',c),e=>console.log('ERROR',e.message))" 2>/dev/null | tail -1)
echo "   Arta Payamak credit check: $CR"
case "$CR" in CREDIT*) echo "PASS  Arta Payamak token works";; *) echo "WARN  Arta Payamak credit check failed (not rolled back; fix in panel)";; esac
U=$(msgadmin list | wc -l); chk "users unchanged ($U)" "$([ "$U" = "$USERS_BEFORE" ] && echo ok)" "before $USERS_BEFORE"
P=$(sqlite3 $DATA/messenger.db "SELECT group_concat(n,'+') FROM (SELECT COUNT(*) n FROM stickers GROUP BY pack_id ORDER BY n DESC)")
chk "sticker packs ($P)" "$([ "$P" = "$PACKS_BEFORE" ] && echo ok)" "before $PACKS_BEFORE"
M=$(sqlite3 $DATA/messenger.db "SELECT COUNT(*) FROM messages")
echo "   messages: before $MSGS_BEFORE, now $M (the hourly 90-day cleanup may remove a few)"
E=$(journalctl -u messenger --since "-1 min" --no-pager | grep -ci "error" || true); echo "   errors in log last minute: $E"

if [ $FAIL = 1 ]; then
  echo "== ROLLBACK (a check failed)"
  systemctl stop messenger
  rm -rf $APP; cp -a "$SAFE/app" $APP
  systemctl start messenger; sleep 4
  echo "after rollback: messenger $(systemctl is-active messenger), health $(curl -sk https://127.0.0.1:8443/api/health)"
  exit 2
fi
echo "== DONE: Sepan 1.16.0 server live. Backup: $SAFE"
