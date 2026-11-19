#!/bin/bash
# Sepan 1.26.0 deploy (on top of 1.24.0, which is live): «در حال مکالمه است» + «منتظر می‌مانم» for calls
# (web call.mjs + Android APK versionCode 32), release notes for 1.26.0. Also brings the 1.25.0 source changes
# (packaged-server support; nothing changes on this server: license checks run only in the packaged executable).
# code.tgz = git archive of claude/project-thread-txylog (commit 8280d93); APK = CI artifact sepan-release-apk.
# No database changes. Backup first (app + database + APK), verify, roll back on failure.
set -uo pipefail
STAGE=/root/sepan-1.26.0
APP=/opt/messenger/app
DATA=/opt/messenger/data
IP=193.151.148.119
DB=$DATA/messenger.db

echo "== pre-checks"
cd $STAGE || { echo "ABORT: no $STAGE"; exit 1; }
rm -rf $STAGE/src && tar xzf code.tgz --strip-components=2 --wildcards '*/server/src' || { echo "ABORT: untar"; exit 1; }
printf '%s\n' "689d31e2ce36ada94d0de1d000e56aee  src/server.js" "e30e47c6da6114abd6109483228ae25e  src/web/app.mjs" "320fc302cf35668ca1e0692a911b368b  src/web/call.mjs" "9573db280cd8c774949b17fabb8bf5df  src/release-notes.json" "90adbdc32e633009e5b100e7680e4f4b  src/admin.html"  | md5sum -c - || { echo "ABORT: checksum"; exit 1; }
grep -q "const VERSION = '1.26.0';" src/web/app.mjs || { echo "ABORT: not the 1.26.0 source"; exit 1; }
APKSUM=$(md5sum sepan-1.26.0.apk 2>/dev/null | cut -d' ' -f1); [ "$APKSUM" = "40e4c1166927af3865eb7e7f18c24bc0" ] || { echo "ABORT: apk checksum $APKSUM"; exit 1; }
for f in src/server.js src/db.js src/core.js src/adminpanel.js src/admindevices.js src/gcall.js src/cli.js src/web.js src/license.js; do node --check $f || { echo "ABORT: syntax $f"; exit 1; }; done
grep -qE "const VERSION = '1\.(24\.0|26\.0)';" $APP/web/app.mjs || { echo "ABORT: expected 1.24.0 live (running: $(grep -m1 'const VERSION' $APP/web/app.mjs))"; exit 1; }
q() { sqlite3 $DB "$1"; }
USERS_BEFORE=$(msgadmin list | wc -l)
MSGS_BEFORE=$(q "SELECT COUNT(*) FROM messages")
CATS_BEFORE=$(q "SELECT group_concat(id||':'||name||':'||gkey, '|') FROM (SELECT * FROM categories ORDER BY id)" | md5sum | cut -c1-32)
SMSCFG_BEFORE=$(q "SELECT value FROM settings WHERE key='sms_cfg_artapayamak'" | md5sum | cut -c1-32)
ADMPW_BEFORE=$(q "SELECT value FROM settings WHERE key='admin_pass'" | md5sum | cut -c1-32)
TOTP_BEFORE=$(q "SELECT value FROM settings WHERE key='admin_totp'" | md5sum | cut -c1-32)
GCFG_BEFORE=$(q "SELECT group_concat(key||'='||value, '|') FROM (SELECT * FROM settings WHERE key LIKE 'gcall_%' ORDER BY key)" | md5sum | cut -c1-32)
DEV_BEFORE=$(q "SELECT COUNT(*) FROM admin_devices")
echo "users: $USERS_BEFORE  messages: $MSGS_BEFORE  running: $(grep -m1 'const VERSION' $APP/web/app.mjs)"

echo "== backup"
TS=$(date +%Y%m%d-%H%M%S)
SAFE=/root/messenger-backup-$TS
mkdir -p "$SAFE"
systemctl stop messenger
cp -a $APP "$SAFE/app"
cp -a $DB* "$SAFE/" 2>/dev/null || true
cp -a $DATA/apk/sepan.apk "$SAFE/sepan.apk" 2>/dev/null || true
echo "backup: $SAFE"

echo "== install"
rm -rf $APP/web
cp -r $STAGE/src/. $APP/
chown -R msg:msg $APP 2>/dev/null || true
mkdir -p $DATA/apk && cp $STAGE/sepan-1.26.0.apk $DATA/apk/sepan.apk.new && mv -f $DATA/apk/sepan.apk.new $DATA/apk/sepan.apk
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
chk "/app.mjs VERSION 1.26.0" "$(grep -q "const VERSION = '1.26.0'" /tmp/sepan-app.mjs && echo ok)" "$(grep -m1 'const VERSION' /tmp/sepan-app.mjs)"
CM=$($W/call.mjs -o /tmp/sepan-call.mjs -w '%{http_code}'); chk "web calls have busy / wait (sig_busy)" "$([ "$CM" = 200 ] && grep -q "sig_busy" /tmp/sepan-call.mjs && grep -q "export function waitForPeer" /tmp/sepan-call.mjs && echo ok)" "$CM"
NT=$(curl -sk 'https://127.0.0.1:8443/api/app/notes?v=1.26.0'); chk "release notes for 1.26.0" "$(echo "$NT" | grep -q 'notes":\["' && echo ok)" "empty"
GC=$($W/groupcall.mjs -o /tmp/sepan-gc.mjs -w '%{http_code}'); chk "group video still served" "$([ "$GC" = 200 ] && grep -q 'export async function toggleCam' /tmp/sepan-gc.mjs && echo ok)" "$GC"
A=$(curl -sk -o /tmp/sepan-admin.html -w '%{http_code}' https://127.0.0.1:8444/); chk "admin panel page 200" "$([ "$A" = 200 ] && grep -q 'devicesCard' /tmp/sepan-admin.html && echo ok)" "$A"
LI=$(curl -sk https://127.0.0.1:8444/admin/api/login-info); chk "panel sign-in still works (login-info)" "$(echo "$LI" | grep -q '"totp"' && echo ok)" "$LI"
DC=$(curl -sk -X POST -H 'content-type: application/json' -d '{"id":"00000000000000000000000000000000"}' -o /dev/null -w '%{http_code}' https://127.0.0.1:8444/admin/api/device/challenge); chk "admin app sign-in endpoint (401 for an unknown phone)" "$([ "$DC" = 401 ] && echo ok)" "$DC"
DV=$(q "SELECT COUNT(*) FROM admin_devices"); chk "paired admin phones unchanged ($DV)" "$([ "$DV" = "$DEV_BEFORE" ] && echo ok)" "before $DEV_BEFORE"
AP=$(md5sum $DATA/apk/sepan.apk | cut -d' ' -f1); chk "Sepan APK 1.26.0 in place" "$([ "$AP" = 40e4c1166927af3865eb7e7f18c24bc0 ] && echo ok)" "$AP"
V=$(curl -sk https://127.0.0.1:8443/api/app/version); chk "app version endpoint 32" "$(echo "$V" | grep -q '"code":32' && echo ok)" "$(echo "$V" | grep -o '"code":[0-9]*')"
CATS=$(q "SELECT group_concat(id||':'||name||':'||gkey, '|') FROM (SELECT * FROM categories ORDER BY id)" | md5sum | cut -c1-32)
chk "groups and channels unchanged" "$([ "$CATS" = "$CATS_BEFORE" ] && echo ok)" "changed"
GCF=$(q "SELECT group_concat(key||'='||value, '|') FROM (SELECT * FROM settings WHERE key LIKE 'gcall_%' ORDER BY key)" | md5sum | cut -c1-32)
chk "group call settings unchanged" "$([ "$GCF" = "$GCFG_BEFORE" ] && echo ok)" "changed"
SMSCFG=$(q "SELECT value FROM settings WHERE key='sms_cfg_artapayamak'" | md5sum | cut -c1-32)
chk "SMS settings unchanged" "$([ "$SMSCFG" = "$SMSCFG_BEFORE" ] && echo ok)" "changed"
ADMPW=$(q "SELECT value FROM settings WHERE key='admin_pass'" | md5sum | cut -c1-32)
chk "admin password unchanged" "$([ "$ADMPW" = "$ADMPW_BEFORE" ] && echo ok)" "changed"
TOTP=$(q "SELECT value FROM settings WHERE key='admin_totp'" | md5sum | cut -c1-32)
chk "panel 2FA unchanged" "$([ "$TOTP" = "$TOTP_BEFORE" ] && echo ok)" "changed"
U=$(msgadmin list | wc -l); chk "users unchanged ($U)" "$([ "$U" = "$USERS_BEFORE" ] && echo ok)" "before $USERS_BEFORE"
M=$(q "SELECT COUNT(*) FROM messages")
echo "   messages: before $MSGS_BEFORE, now $M (the hourly 90-day cleanup may remove a few)"
E=$(journalctl -u messenger --since "-1 min" --no-pager | grep -ci "error" || true); echo "   errors in log last minute: $E"

if [ $FAIL = 1 ]; then
  echo "== ROLLBACK (a check failed): app, database and APK back to the backup"
  systemctl stop messenger
  rm -rf $APP; cp -a "$SAFE/app" $APP
  rm -f $DB-wal $DB-shm; cp -a "$SAFE"/messenger.db* $DATA/
  [ -f "$SAFE/sepan.apk" ] && cp -a "$SAFE/sepan.apk" $DATA/apk/sepan.apk
  systemctl start messenger; sleep 4
  echo "after rollback: messenger $(systemctl is-active messenger), health $(curl -sk https://127.0.0.1:8443/api/health)"
  exit 2
fi
echo "== DONE: Sepan 1.26.0 live (busy + wait for calls; APK versionCode 32). Backup: $SAFE"
