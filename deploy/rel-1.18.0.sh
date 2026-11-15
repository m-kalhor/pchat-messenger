#!/bin/bash
# Sepan 1.18.0 deploy (server only): admin panel second factor (authenticator code) and per-address
# sign-in lockout. code.tgz = any tar.gz of this branch with one top folder (git archive or the GitHub tarball).
# No APK. Keeps data/certs/config and the SMS settings as they are. Backup first, verify, roll back on failure.
# The second factor stays OFF after the install; the admin turns it on in the panel («حساب مدیر»).
set -uo pipefail
STAGE=/root/sepan-1.18.0
APP=/opt/messenger/app
DATA=/opt/messenger/data
IP=193.151.148.119

echo "== pre-checks"
cd $STAGE || { echo "ABORT: no $STAGE"; exit 1; }
rm -rf $STAGE/src && tar xzf code.tgz --strip-components=2 --wildcards '*/server/src' || { echo "ABORT: untar"; exit 1; }
printf '%s\n' "0d4ec9680b4d8b0a44e9857ed4e59e0d  src/totp.js" "c29fdef7dbeb6731614cafbb6ee09b1f  src/adminpanel.js" "b127f25da2a2199d7aebbb361a28ebd5  src/admin.html" "9557d726f1454597aeefbb4cf5050f7a  src/web/app.mjs" | md5sum -c - || { echo "ABORT: checksum"; exit 1; }
grep -q "const VERSION = '1.18.0';" src/web/app.mjs || { echo "ABORT: not the 1.18.0 source"; exit 1; }
for f in src/server.js src/adminpanel.js src/totp.js src/cli.js src/web.js; do node --check $f || { echo "ABORT: syntax $f"; exit 1; }; done
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
chk "/app.mjs VERSION 1.18.0" "$(grep -q "const VERSION = '1.18.0'" /tmp/sepan-app.mjs && echo ok)" "$(grep -m1 'const VERSION' /tmp/sepan-app.mjs)"
A=$(curl -sk -o /tmp/sepan-admin.html -w '%{http_code}' https://127.0.0.1:8444/); chk "admin panel page 200" "$([ "$A" = 200 ] && echo ok)" "$A"
chk "panel has the second-factor card" "$(grep -q 'totpCard' /tmp/sepan-admin.html && echo ok)" "missing"
LI=$(curl -sk https://127.0.0.1:8444/admin/api/login-info); chk "login-info answers ($LI)" "$(echo "$LI" | grep -q '"totp":false' && echo ok)" "$LI"
U401=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:8444/admin/api/state); chk "panel API still needs sign-in (401)" "$([ "$U401" = 401 ] && echo ok)" "$U401"
C=$(curl -sk https://127.0.0.1:8443/api/auth/config); chk "login offers SMS ($C)" "$(echo "$C" | grep -q '"sms":true' && echo ok)" "$C"
SMSCFG=$(sqlite3 $DATA/messenger.db "SELECT value FROM settings WHERE key='sms_cfg_artapayamak'" | md5sum | cut -c1-32)
chk "SMS settings unchanged" "$([ "$SMSCFG" = "$SMSCFG_BEFORE" ] && echo ok)" "changed"
ADMPW=$(sqlite3 $DATA/messenger.db "SELECT value FROM settings WHERE key='admin_pass'" | md5sum | cut -c1-32)
chk "admin password unchanged" "$([ "$ADMPW" = "$ADMPW_BEFORE" ] && echo ok)" "changed"
V=$(curl -sk https://127.0.0.1:8443/api/app/version); chk "app version endpoint still 23 ($V)" "$(echo "$V" | grep -q '"code":23' && echo ok)" "$V"
U=$(msgadmin list | wc -l); chk "users unchanged ($U)" "$([ "$U" = "$USERS_BEFORE" ] && echo ok)" "before $USERS_BEFORE"
chk "msgadmin knows totp-off" "$(msgadmin 2>&1 | grep -q totp-off && echo ok)" "missing"
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
echo "== DONE: Sepan 1.18.0 live (server only). Backup: $SAFE"
echo "Next: panel > حساب مدیر > فعال کردن رمز دوم"
