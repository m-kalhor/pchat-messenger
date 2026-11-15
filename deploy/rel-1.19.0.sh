#!/bin/bash
# Sepan 1.19.0 deploy: group voice calls + Calls tab (server, web) and the Android APK 1.19.0 (versionCode 25),
# plus coturn's session log for the «ترافیک رله تماس» column. Includes 1.18.0 (already live).
# code.tgz = any tar.gz of this branch with one top folder (git archive or the GitHub tarball);
# sepan-1.19.0.apk = the CI artifact sepan-release-apk (app-release.apk) of the same commit.
# Keeps data/certs/config and the SMS / admin settings as they are. Backup first, verify, roll back on failure.
# Group calls stay OFF after the install; the admin turns them on in the panel (card «تماس گروهی»).
set -uo pipefail
STAGE=/root/sepan-1.19.0
APP=/opt/messenger/app
DATA=/opt/messenger/data
IP=193.151.148.119
TLOG=/var/log/sepan-turn/turn.log

echo "== pre-checks"
cd $STAGE || { echo "ABORT: no $STAGE"; exit 1; }
rm -rf $STAGE/src && tar xzf code.tgz --strip-components=2 --wildcards '*/server/src' || { echo "ABORT: untar"; exit 1; }
printf '%s\n' "64190167d7d310b3973280e2d36d85cd  src/gcall.js" "71a6cc5c7fe5a751e6a0553fde8efc6e  src/turnlog.js" "775dd0e613b1e93b367dd155669543e0  src/web/app.mjs" "4048ed9fe904ebe7ed70f627def0a25f  src/web/groupcall.mjs" "f73c1bade4dc883fe8e9b48620405251  src/server.js" | md5sum -c - || { echo "ABORT: checksum"; exit 1; }
grep -q "const VERSION = '1.19.0';" src/web/app.mjs || { echo "ABORT: not the 1.19.0 source"; exit 1; }
[ -s sepan-1.19.0.apk ] && [ "$(stat -c %s sepan-1.19.0.apk)" -gt 1000000 ] && [ "$(head -c2 sepan-1.19.0.apk)" = PK ] || { echo "ABORT: sepan-1.19.0.apk missing or not an APK"; exit 1; }
for f in src/server.js src/gcall.js src/turnlog.js src/usage.js src/adminpanel.js src/totp.js; do node --check $f || { echo "ABORT: syntax $f"; exit 1; }; done
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
cp -a $DATA/apk/sepan.apk "$SAFE/sepan.apk" 2>/dev/null || true
cp -a /etc/turnserver.conf "$SAFE/turnserver.conf"
cp -a /etc/systemd/system/messenger.service.d/turn.conf "$SAFE/turn.conf" 2>/dev/null || true
echo "backup: $SAFE"

echo "== install"
rm -rf $APP/web
cp -r $STAGE/src/. $APP/
chown -R msg:msg $APP 2>/dev/null || true
mkdir -p $DATA/apk && cp $STAGE/sepan-1.19.0.apk $DATA/apk/sepan.apk.new && mv -f $DATA/apk/sepan.apk.new $DATA/apk/sepan.apk
chown --reference=$DATA $DATA/apk $DATA/apk/sepan.apk 2>/dev/null || true
# coturn session log (one "usage" line per relayed session), readable by the messenger (group msg)
mkdir -p /var/log/sepan-turn
chown turnserver:msg /var/log/sepan-turn; chmod 750 /var/log/sepan-turn
cat > /etc/logrotate.d/sepan-turn <<'ROT'
/var/log/sepan-turn/turn.log {
  size 20M
  rotate 2
  copytruncate
  missingok
  notifempty
  compress
}
ROT
grep -q '^log-file=' /etc/turnserver.conf || printf 'log-file=%s\nsimple-log\n' "$TLOG" >> /etc/turnserver.conf
grep -q '^Environment=TURN_LOG_FILE=' /etc/systemd/system/messenger.service.d/turn.conf || echo "Environment=TURN_LOG_FILE=$TLOG" >> /etc/systemd/system/messenger.service.d/turn.conf
systemctl daemon-reload
systemctl restart coturn
systemctl start messenger
sleep 6

echo "== verify"
FAIL=0
chk() { if [ "$2" = ok ]; then echo "PASS  $1"; else echo "FAIL  $1  ($3)"; FAIL=1; fi; }
S=$(systemctl is-active messenger); chk "messenger active" "$([ "$S" = active ] && echo ok)" "$S"
T=$(systemctl is-active coturn); chk "coturn active" "$([ "$T" = active ] && echo ok)" "$T"
H=$(curl -sk https://127.0.0.1:8443/api/health); chk "health 8443" "$(echo "$H" | grep -qi ok && echo ok)" "$H"
W="curl -s --cacert /opt/messenger/ca/ca.pem --resolve $IP:443:127.0.0.1 https://$IP"
H2=$($W/api/health); chk "web health 443" "$(echo "$H2" | grep -qi ok && echo ok)" "$H2"
$W/app.mjs -o /tmp/sepan-app.mjs
chk "/app.mjs VERSION 1.19.0" "$(grep -q "const VERSION = '1.19.0'" /tmp/sepan-app.mjs && echo ok)" "$(grep -m1 'const VERSION' /tmp/sepan-app.mjs)"
GC=$($W/groupcall.mjs -o /dev/null -w '%{http_code}'); chk "/groupcall.mjs served" "$([ "$GC" = 200 ] && echo ok)" "$GC"
G401=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/api/gcall); chk "/api/gcall needs sign-in (401)" "$([ "$G401" = 401 ] && echo ok)" "$G401"
A=$(curl -sk -o /tmp/sepan-admin.html -w '%{http_code}' https://127.0.0.1:8444/); chk "admin panel page 200" "$([ "$A" = 200 ] && echo ok)" "$A"
chk "panel has the group call card and 2FA card" "$(grep -q 'bad_gcall_settings' /tmp/sepan-admin.html && grep -q 'totpCard' /tmp/sepan-admin.html && echo ok)" "missing"
chk "usage table has the turn column" "$(sqlite3 $DATA/messenger.db "PRAGMA table_info(usage_daily)" | grep -q '|turn|' && echo ok)" "missing"
chk "messenger sees TURN_LOG_FILE" "$(systemctl show messenger -p Environment | grep -q TURN_LOG_FILE && echo ok)" "missing"
C=$(curl -sk https://127.0.0.1:8443/api/auth/config); chk "login offers SMS ($C)" "$(echo "$C" | grep -q '"sms":true' && echo ok)" "$C"
SMSCFG=$(sqlite3 $DATA/messenger.db "SELECT value FROM settings WHERE key='sms_cfg_artapayamak'" | md5sum | cut -c1-32)
chk "SMS settings unchanged" "$([ "$SMSCFG" = "$SMSCFG_BEFORE" ] && echo ok)" "changed"
ADMPW=$(sqlite3 $DATA/messenger.db "SELECT value FROM settings WHERE key='admin_pass'" | md5sum | cut -c1-32)
chk "admin password unchanged" "$([ "$ADMPW" = "$ADMPW_BEFORE" ] && echo ok)" "changed"
V=$(curl -sk https://127.0.0.1:8443/api/app/version); chk "app version endpoint 25 ($V)" "$(echo "$V" | grep -q '"code":25' && echo ok)" "$V"
U=$(msgadmin list | wc -l); chk "users unchanged ($U)" "$([ "$U" = "$USERS_BEFORE" ] && echo ok)" "before $USERS_BEFORE"
M=$(sqlite3 $DATA/messenger.db "SELECT COUNT(*) FROM messages")
echo "   messages: before $MSGS_BEFORE, now $M (the hourly 90-day cleanup may remove a few)"
echo "   coturn log: $(ls -l $TLOG 2>&1)"
E=$(journalctl -u messenger --since "-1 min" --no-pager | grep -ci "error" || true); echo "   errors in log last minute: $E"

if [ $FAIL = 1 ]; then
  echo "== ROLLBACK (a check failed)"
  systemctl stop messenger
  rm -rf $APP; cp -a "$SAFE/app" $APP
  [ -f "$SAFE/sepan.apk" ] && cp -a "$SAFE/sepan.apk" $DATA/apk/sepan.apk
  cp -a "$SAFE/turnserver.conf" /etc/turnserver.conf
  [ -f "$SAFE/turn.conf" ] && cp -a "$SAFE/turn.conf" /etc/systemd/system/messenger.service.d/turn.conf
  systemctl daemon-reload; systemctl restart coturn
  systemctl start messenger; sleep 4
  echo "after rollback: messenger $(systemctl is-active messenger), coturn $(systemctl is-active coturn), health $(curl -sk https://127.0.0.1:8443/api/health)"
  exit 2
fi
echo "== DONE: Sepan 1.19.0 live (server + APK versionCode 25). Backup: $SAFE"
echo "Next: panel > تنظیمات > card «تماس گروهی»: turn group calls on and pick the groups"
