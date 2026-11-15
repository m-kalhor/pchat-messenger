#!/bin/bash
# Sepan 1.17.0 deploy: country picker at sign-in (web), contact lookup cap 5000/day (server),
# and the Android APK 1.17.0 (versionCode 23) put where the panel's upload puts it.
# code.tgz = any tar.gz of this branch with one top folder (git archive or the GitHub tarball);
# sepan-1.17.0.apk = the CI artifact sepan-release-apk (app-release.apk) of the same commit. Keeps data/certs/config and the
# SMS settings (Arta Payamak) as they are. Backup first, verify, roll back on failure.
set -uo pipefail
STAGE=/root/sepan-1.17.0
APP=/opt/messenger/app
DATA=/opt/messenger/data
IP=193.151.148.119

echo "== pre-checks"
cd $STAGE || { echo "ABORT: no $STAGE"; exit 1; }
rm -rf $STAGE/src && tar xzf code.tgz --strip-components=2 --wildcards '*/server/src' || { echo "ABORT: untar"; exit 1; }
printf '%s\n' "46871026807becfd1703a98a54805e6d  src/web/countries.mjs" "e85c1cf3d2ba8c4bab0f8bd9a5b207ba  src/web/app.mjs" "b322cab8ef22e655b16b225bac022fc5  src/server.js" | md5sum -c - || { echo "ABORT: checksum"; exit 1; }
grep -q "const VERSION = '1.17.0';" src/web/app.mjs || { echo "ABORT: not the 1.17.0 source"; exit 1; }
APKSUM=$(md5sum sepan-1.17.0.apk 2>/dev/null | cut -d' ' -f1); [ "$APKSUM" = "78b54d31666490069355764f59e4e570" ] || { echo "ABORT: apk checksum $APKSUM"; exit 1; }
for f in src/server.js src/auth.js src/adminpanel.js src/sms/index.js; do node --check $f || { echo "ABORT: syntax $f"; exit 1; }; done
USERS_BEFORE=$(msgadmin list | wc -l)
PACKS_BEFORE=$(sqlite3 $DATA/messenger.db "SELECT group_concat(n,'+') FROM (SELECT COUNT(*) n FROM stickers GROUP BY pack_id ORDER BY n DESC)")
MSGS_BEFORE=$(sqlite3 $DATA/messenger.db "SELECT COUNT(*) FROM messages")
SMSCFG_BEFORE=$(sqlite3 $DATA/messenger.db "SELECT value FROM settings WHERE key='sms_cfg_artapayamak'" | md5sum | cut -c1-32)
echo "users: $USERS_BEFORE  packs: $PACKS_BEFORE  messages: $MSGS_BEFORE  running: $(grep -m1 'const VERSION' $APP/web/app.mjs)"

echo "== backup"
TS=$(date +%Y%m%d-%H%M%S)
SAFE=/root/messenger-backup-$TS
mkdir -p "$SAFE"
systemctl stop messenger
cp -a $APP "$SAFE/app"
cp -a $DATA/messenger.db* "$SAFE/" 2>/dev/null || true
cp -a $DATA/apk/sepan.apk "$SAFE/sepan.apk" 2>/dev/null || true
echo "backup: $SAFE"

echo "== install"
rm -rf $APP/web
cp -r $STAGE/src/. $APP/
chown -R msg:msg $APP 2>/dev/null || true
mkdir -p $DATA/apk && cp $STAGE/sepan-1.17.0.apk $DATA/apk/sepan.apk.new && mv -f $DATA/apk/sepan.apk.new $DATA/apk/sepan.apk
chown --reference=$DATA $DATA/apk $DATA/apk/sepan.apk 2>/dev/null || true
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
chk "/app.mjs VERSION 1.17.0" "$(grep -q "const VERSION = '1.17.0'" /tmp/sepan-app.mjs && echo ok)" "$(grep -m1 'const VERSION' /tmp/sepan-app.mjs)"
$W/countries.mjs -o /tmp/sepan-countries.mjs
chk "/countries.mjs served" "$(grep -q "'IR', 'ایران', '98'" /tmp/sepan-countries.mjs && echo ok)" "missing"
C=$(curl -sk https://127.0.0.1:8443/api/auth/config); chk "login offers SMS ($C)" "$(echo "$C" | grep -q '"sms":true' && echo ok)" "$C"
SF=$(curl -sk -X POST -H 'Content-Type: application/json' -d '{"phone":"+4915112345678"}' https://127.0.0.1:8443/api/auth/sms)
chk "foreign number gets sms_foreign (no SMS sent)" "$(echo "$SF" | grep -q sms_foreign && echo ok)" "$SF"
SMSCFG=$(sqlite3 $DATA/messenger.db "SELECT value FROM settings WHERE key='sms_cfg_artapayamak'" | md5sum | cut -c1-32)
chk "SMS settings unchanged" "$([ "$SMSCFG" = "$SMSCFG_BEFORE" ] && echo ok)" "changed"
V=$(curl -sk https://127.0.0.1:8443/api/app/version); chk "app version endpoint 23 ($V)" "$(echo "$V" | grep -q '"code":23' && echo ok)" "$V"
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
  [ -f "$SAFE/sepan.apk" ] && cp -a "$SAFE/sepan.apk" $DATA/apk/sepan.apk
  systemctl start messenger; sleep 4
  echo "after rollback: messenger $(systemctl is-active messenger), health $(curl -sk https://127.0.0.1:8443/api/health)"
  exit 2
fi
echo "== DONE: Sepan 1.17.0 live (server + APK versionCode 23). Backup: $SAFE"
