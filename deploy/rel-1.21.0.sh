#!/bin/bash
# Sepan 1.21.0 deploy (on top of 1.20.0, which must already be live): channels users make (shared channel key, only
# owner/admins post, members hidden from each other, view counts), panel channels section, and the Android APK 1.21.0
# (versionCode 27) put where the panel's upload puts it. Channels stay OFF until the admin turns them on in the panel.
# The database gets categories.ckv/sign and table chan_keys; groups and memberships are kept as they are.
# code.tgz = any tar.gz of this branch with one top folder; sepan-1.21.0.apk = CI artifact sepan-release-apk.
# Keeps data/certs/config and the SMS settings. Backup first (app + database + APK), verify, roll back on failure.
set -uo pipefail
STAGE=/root/sepan-1.21.0
APP=/opt/messenger/app
DATA=/opt/messenger/data
IP=193.151.148.119
DB=$DATA/messenger.db

echo "== pre-checks"
cd $STAGE || { echo "ABORT: no $STAGE"; exit 1; }
rm -rf $STAGE/src && tar xzf code.tgz --strip-components=2 --wildcards '*/server/src' || { echo "ABORT: untar"; exit 1; }
printf '%s\n' "5fdf559ff352bb95fe69a071a16372bb  src/ugroups.js" "56a25041856f64e1a8f65c7a148c4859  src/server.js" "39d34ee184e7a314e27e1e62e82290a9  src/db.js" "8e4e496ff18a5f1fba7029e59233b1b9  src/core.js" "440d818c754856062d0c79bf454bec1b  src/web/app.mjs" "caddffb84df69ce2bf9ea10b1f907002  src/web/engine.mjs" "3cfa8872735174e9737fb1b33cf81f64  src/web/crypto.mjs" "1343636ffe3c2ca45980b4bc51382076  src/admin.html" | md5sum -c - || { echo "ABORT: checksum"; exit 1; }
grep -q "const VERSION = '1.21.0';" src/web/app.mjs || { echo "ABORT: not the 1.21.0 source"; exit 1; }
APKSUM=$(md5sum sepan-1.21.0.apk 2>/dev/null | cut -d' ' -f1); [ "$APKSUM" = "97991d18e941cf4bc88fed647bdfa748" ] || { echo "ABORT: apk checksum $APKSUM"; exit 1; }
for f in src/server.js src/ugroups.js src/db.js src/core.js src/adminpanel.js src/gcall.js src/cli.js src/web.js; do node --check $f || { echo "ABORT: syntax $f"; exit 1; }; done
grep -qE "const VERSION = '1\.(20\.0|21\.0)';" $APP/web/app.mjs || { echo "ABORT: install 1.20.0 first (running: $(grep -m1 'const VERSION' $APP/web/app.mjs))"; exit 1; }
q() { sqlite3 $DB "$1"; }
USERS_BEFORE=$(msgadmin list | wc -l)
MSGS_BEFORE=$(q "SELECT COUNT(*) FROM messages")
CATS_BEFORE=$(q "SELECT group_concat(id||':'||name||':'||gkey, '|') FROM (SELECT * FROM categories ORDER BY id)" | md5sum | cut -c1-32)
UG_BEFORE=$(q "SELECT COUNT(*) FROM categories WHERE kind='user'")
UC_BEFORE=$(q "SELECT group_concat(username||':'||category_id, '|') FROM (SELECT * FROM user_categories ORDER BY username, category_id)" | md5sum | cut -c1-32)
SMSCFG_BEFORE=$(q "SELECT value FROM settings WHERE key='sms_cfg_artapayamak'" | md5sum | cut -c1-32)
ADMPW_BEFORE=$(q "SELECT value FROM settings WHERE key='admin_pass'" | md5sum | cut -c1-32)
echo "users: $USERS_BEFORE  messages: $MSGS_BEFORE  categories: $(q 'SELECT COUNT(*) FROM categories')  running: $(grep -m1 'const VERSION' $APP/web/app.mjs)"

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
mkdir -p $DATA/apk && cp $STAGE/sepan-1.21.0.apk $DATA/apk/sepan.apk.new && mv -f $DATA/apk/sepan.apk.new $DATA/apk/sepan.apk
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
chk "/app.mjs VERSION 1.21.0" "$(grep -q "const VERSION = '1.21.0'" /tmp/sepan-app.mjs && echo ok)" "$(grep -m1 'const VERSION' /tmp/sepan-app.mjs)"
GC=$($W/groupcall.mjs -o /dev/null -w '%{http_code}'); chk "group calls still served" "$([ "$GC" = 200 ] && echo ok)" "$GC"
A=$(curl -sk -o /tmp/sepan-admin.html -w '%{http_code}' https://127.0.0.1:8444/); chk "admin panel page 200" "$([ "$A" = 200 ] && echo ok)" "$A"
chk "panel has the user groups tab" "$(grep -q 'ugroupsTab' /tmp/sepan-admin.html && echo ok)" "missing"
U401=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:8444/admin/api/ugroups); chk "panel groups API needs sign-in (401)" "$([ "$U401" = 401 ] && echo ok)" "$U401"
K=$(q "SELECT COUNT(*) FROM pragma_table_info('categories') WHERE name IN ('ckv','sign')"); chk "database migrated (categories.ckv, sign)" "$([ "$K" = 2 ] && echo ok)" "$K"
T=$(q "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chan_keys'"); chk "table chan_keys" "$([ "$T" = 1 ] && echo ok)" "$T"
CATS=$(q "SELECT group_concat(id||':'||name||':'||gkey, '|') FROM (SELECT * FROM categories ORDER BY id)" | md5sum | cut -c1-32)
chk "groups unchanged" "$([ "$CATS" = "$CATS_BEFORE" ] && echo ok)" "changed"
UC=$(q "SELECT group_concat(username||':'||category_id, '|') FROM (SELECT * FROM user_categories ORDER BY username, category_id)" | md5sum | cut -c1-32)
chk "group memberships unchanged" "$([ "$UC" = "$UC_BEFORE" ] && echo ok)" "changed"
UG=$(q "SELECT COUNT(*) FROM categories WHERE kind='user'"); chk "user groups kept ($UG)" "$([ "$UG" = "$UG_BEFORE" ] && echo ok)" "before $UG_BEFORE"
CH=$(q "SELECT COUNT(*) FROM categories WHERE kind='chan'"); chk "no channels yet ($CH)" "$([ "$CH" = 0 ] && echo ok)" "$CH"
ON=$(q "SELECT COALESCE((SELECT value FROM settings WHERE key='chans_on'),'0')"); chk "channels are off until the admin turns them on" "$([ "$ON" = 0 ] && echo ok)" "$ON"
J=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/api/ugroups/1/keys); chk "channel keys API needs sign-in (401)" "$([ "$J" = 401 ] && echo ok)" "$J"
chk "panel has the channels switch" "$(grep -q 'chan_on' /tmp/sepan-admin.html && echo ok)" "missing"
C=$(curl -sk https://127.0.0.1:8443/api/auth/config); chk "login offers SMS ($C)" "$(echo "$C" | grep -q '"sms":true' && echo ok)" "$C"
SMSCFG=$(q "SELECT value FROM settings WHERE key='sms_cfg_artapayamak'" | md5sum | cut -c1-32)
chk "SMS settings unchanged" "$([ "$SMSCFG" = "$SMSCFG_BEFORE" ] && echo ok)" "changed"
ADMPW=$(q "SELECT value FROM settings WHERE key='admin_pass'" | md5sum | cut -c1-32)
chk "admin password unchanged" "$([ "$ADMPW" = "$ADMPW_BEFORE" ] && echo ok)" "changed"
V=$(curl -sk https://127.0.0.1:8443/api/app/version); chk "app version endpoint 27 ($V)" "$(echo "$V" | grep -q '"code":27' && echo ok)" "$V"
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
echo "== DONE: Sepan 1.21.0 live (server + APK versionCode 26). Backup: $SAFE"
echo "Turn channels on: panel tab (user groups and channels) > settings card > channels on"
