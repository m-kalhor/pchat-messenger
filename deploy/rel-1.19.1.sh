#!/bin/bash
# Sepan 1.19.1 deploy (server only, on top of 1.19.0 which must already be live): 6-digit SMS codes counted per account, overall SMS budget, password
# lockout per account + address, per-user upload quota, setup page / iPhone profile / APK only over https on the domain. code.tgz = any tar.gz of this branch with one top folder (git archive or the GitHub tarball).
# No APK. Keeps data/certs/config and the SMS settings as they are. Backup first, verify, roll back on failure.
set -uo pipefail
STAGE=/root/sepan-1.19.1
APP=/opt/messenger/app
DATA=/opt/messenger/data
IP=193.151.148.119

echo "== pre-checks"
cd $STAGE || { echo "ABORT: no $STAGE"; exit 1; }
rm -rf $STAGE/src && tar xzf code.tgz --strip-components=2 --wildcards '*/server/src' || { echo "ABORT: untar"; exit 1; }
printf '%s\n' "678e2d937c58b1138675925c5d2a3af5  src/auth.js" "698a455db4188e9ca4e1f0693bf59194  src/server.js" "fc77f1e0390523a54a856e5b1401da1a  src/web.js" "53cfb3f195c4d3b374c349ab3e8d4b18  src/web/app.mjs" "64190167d7d310b3973280e2d36d85cd  src/gcall.js" | md5sum -c - || { echo "ABORT: checksum"; exit 1; }
grep -q "const VERSION = '1.19.1';" src/web/app.mjs || { echo "ABORT: not the 1.19.1 source"; exit 1; }
for f in src/server.js src/adminpanel.js src/totp.js src/cli.js src/web.js src/gcall.js src/turnlog.js; do node --check $f || { echo "ABORT: syntax $f"; exit 1; }; done
grep -qE "const VERSION = '1\.19\.[01]';" $APP/web/app.mjs || { echo "ABORT: install 1.19.0 first (running: $(grep -m1 'const VERSION' $APP/web/app.mjs))"; exit 1; }
USERS_BEFORE=$(msgadmin list | wc -l)
MSGS_BEFORE=$(sqlite3 $DATA/messenger.db "SELECT COUNT(*) FROM messages")
SMSCFG_BEFORE=$(sqlite3 $DATA/messenger.db "SELECT value FROM settings WHERE key='sms_cfg_artapayamak'" | md5sum | cut -c1-32)
ADMPW_BEFORE=$(sqlite3 $DATA/messenger.db "SELECT value FROM settings WHERE key='admin_pass'" | md5sum | cut -c1-32)
echo "users: $USERS_BEFORE  messages: $MSGS_BEFORE  running: $(grep -m1 'const VERSION' $APP/web/app.mjs)"

echo "== backup"
TS=$(date +%Y%m%d-%H%M%S)
SAFE=/root/messenger-backup-$TS
mkdir -p "$SAFE"
systemctl stop messenger
cp -a $APP "$SAFE/app"
cp -a $DATA/messenger.db* "$SAFE/" 2>/dev/null || true
echo "backup: $SAFE"

echo "== install"
rm -rf $APP/web
cp -r $STAGE/src/. $APP/
chown -R msg:msg $APP 2>/dev/null || true
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
chk "/app.mjs VERSION 1.19.1" "$(grep -q "const VERSION = '1.19.1'" /tmp/sepan-app.mjs && echo ok)" "$(grep -m1 'const VERSION' /tmp/sepan-app.mjs)"
GC=$($W/groupcall.mjs -o /dev/null -w '%{http_code}'); chk "group calls still served" "$([ "$GC" = 200 ] && echo ok)" "$GC"
A=$(curl -sk -o /tmp/sepan-admin.html -w '%{http_code}' https://127.0.0.1:8444/); chk "admin panel page 200" "$([ "$A" = 200 ] && echo ok)" "$A"
chk "panel has the SMS limit fields and group call card" "$(grep -q 'sms_max_hour' /tmp/sepan-admin.html && grep -q 'bad_gcall_settings' /tmp/sepan-admin.html && echo ok)" "missing"
LI=$(curl -sk https://127.0.0.1:8444/admin/api/login-info); chk "panel second factor endpoint ($LI)" "$(echo "$LI" | grep -q '"totp":' && echo ok)" "$LI"
DOM=$(ls /opt/messenger/certs/le 2>/dev/null | head -1)
if [ -n "$DOM" ]; then
  L=$(curl -s -o /dev/null -w '%{redirect_url}' -H "Host: $IP" http://127.0.0.1/setup); chk "http setup page goes to https://$DOM ($L)" "$([ "$L" = "https://$DOM/setup" ] && echo ok)" "$L"
  L=$(curl -s -o /dev/null -w '%{redirect_url}' -H "Host: $IP" http://127.0.0.1/download/sepan.apk); chk "http APK goes to https://$DOM ($L)" "$([ "$L" = "https://$DOM/download/sepan.apk" ] && echo ok)" "$L"
  L=$(curl -s -o /dev/null -w '%{redirect_url}' -H "Host: $IP" http://127.0.0.1/); chk "http / still goes to the IP app ($L)" "$([ "$L" = "https://$IP/" ] && echo ok)" "$L"
  curl -s --resolve "$DOM:443:127.0.0.1" "https://$DOM/setup" -o /tmp/sepan-setup.html
  chk "setup page on the domain opens the app on the IP" "$(grep 'id="open"' /tmp/sepan-setup.html | grep -q "https://$IP/" && echo ok)" "missing"
  HS=$(curl -s -D - -o /dev/null --resolve "$DOM:443:127.0.0.1" "https://$DOM/app" | grep -ci strict-transport || true); chk "HSTS on the domain" "$([ "$HS" -ge 1 ] && echo ok)" "none"
else echo "   (no domain certificate: the setup page stays on http as before)"; fi
U401=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:8444/admin/api/state); chk "panel API still needs sign-in (401)" "$([ "$U401" = 401 ] && echo ok)" "$U401"
C=$(curl -sk https://127.0.0.1:8443/api/auth/config); chk "login offers SMS ($C)" "$(echo "$C" | grep -q '"sms":true' && echo ok)" "$C"
SMSCFG=$(sqlite3 $DATA/messenger.db "SELECT value FROM settings WHERE key='sms_cfg_artapayamak'" | md5sum | cut -c1-32)
chk "SMS settings unchanged" "$([ "$SMSCFG" = "$SMSCFG_BEFORE" ] && echo ok)" "changed"
ADMPW=$(sqlite3 $DATA/messenger.db "SELECT value FROM settings WHERE key='admin_pass'" | md5sum | cut -c1-32)
chk "admin password unchanged" "$([ "$ADMPW" = "$ADMPW_BEFORE" ] && echo ok)" "changed"
V=$(curl -sk https://127.0.0.1:8443/api/app/version); chk "app version endpoint still 25 ($V)" "$(echo "$V" | grep -q '"code":25' && echo ok)" "$V"
U=$(msgadmin list | wc -l); chk "users unchanged ($U)" "$([ "$U" = "$USERS_BEFORE" ] && echo ok)" "before $USERS_BEFORE"
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
echo "== DONE: Sepan 1.19.1 live (server only). Backup: $SAFE"
echo "Panel > ورود، پیامک و تماس: SMS limits (default 40 an hour, 300 a day)"
