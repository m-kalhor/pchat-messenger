#!/bin/bash
# Private messenger server installer / upgrader. Installs the server from ./src next to this
# script, the systemd service, the TLS certificate, coturn (voice/video calls), the admin panel and
# the web version for iPhone (port 443, certificate from the private "Sepan Root CA", setup page on port 80).
# Safe to re-run: an existing install is backed up first and the certificate, TURN secret and
# database are kept.
# Run as root:
#   bash install.sh YOUR_SERVER_IP            admin panel open to the whole Internet (https, port 8444, rate-limited)
#   bash install.sh YOUR_SERVER_IP ADMIN_IP   admin panel open only to that single IP
#   bash install.sh YOUR_SERVER_IP local      admin panel reachable only from the server itself (SSH tunnel)
set -euo pipefail
IP="${1:-}"
MODE="${2:-open}"
if [ -z "$IP" ]; then echo "Usage: bash install.sh YOUR_SERVER_IP [open|local|ADMIN_IP]"; exit 1; fi
if [ "$(id -u)" != "0" ]; then echo "Run as root"; exit 1; fi
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/src"
if [ ! -f "$SRC/server.js" ]; then echo "Server source not found in $SRC"; exit 1; fi

id msg >/dev/null 2>&1 || adduser --system --group --home /opt/messenger msg
APP=/opt/messenger/app
mkdir -p $APP /opt/messenger/data/files /opt/messenger/certs

# --- safety copy of an existing version + database, then stop the service ---
SAFE=""
if [ -f $APP/server.js ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  SAFE=/root/messenger-backup-$TS
  mkdir -p "$SAFE"
  systemctl stop messenger || true
  cp -a $APP "$SAFE/app"
  cp -a /opt/messenger/data/messenger.db* "$SAFE/" 2>/dev/null || true
  echo "Old version + database saved in $SAFE"
fi

# --- server source ---
rm -f $APP/admin.js
rm -rf $APP/web
cp -r "$SRC"/. $APP/

# --- TLS certificate (self-signed, valid 10 years, bound to the server IP) ---
if [ ! -f /opt/messenger/certs/key.pem ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout /opt/messenger/certs/key.pem -out /opt/messenger/certs/cert.pem -days 3650 \
    -subj "/CN=messenger" -addext "subjectAltName=IP:$IP"
fi

# --- web version: private root CA (key stays root-only) + certificate for port 443 ---
# iPhones install ca.pem once as a profile (http://IP/setup). The Android app's pinned certificate above is not involved.
CA_DIR=/opt/messenger/ca
mkdir -p $CA_DIR /opt/messenger/certs/web
chmod 700 $CA_DIR
if [ ! -f $CA_DIR/ca.key ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout $CA_DIR/ca.key -out $CA_DIR/ca.pem -days 3650 -subj "/CN=Sepan Root CA/O=Sepan" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign"
fi
chmod 600 $CA_DIR/ca.key
cp $CA_DIR/ca.pem /opt/messenger/certs/web/ca.pem
cat > /usr/local/sbin/sepan-web-cert <<'CERT'
#!/bin/bash
# Issues or renews the web (port 443) certificate from the private Sepan Root CA when it is missing,
# expires within 30 days or does not match the server IP. A certificate from another CA
# (for example Let's Encrypt for a domain) is left alone. The server reloads it within an hour.
set -euo pipefail
IP="$(cat /opt/messenger/web-ip)"
D=/opt/messenger/certs/web
CA=/opt/messenger/ca
if [ -f $D/cert.pem ] && [ -f $D/key.pem ]; then
  openssl verify -no_check_time -CAfile $CA/ca.pem $D/cert.pem >/dev/null 2>&1 || exit 0
  if openssl x509 -in $D/cert.pem -noout -checkend 2592000 >/dev/null &&
     openssl x509 -in $D/cert.pem -noout -text | grep -q "IP Address:$IP\$"; then exit 0; fi
fi
T=$(mktemp -d)
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout $T/key.pem -out $T/req.csr -subj "/CN=$IP"
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:%s\n' "$IP" > $T/ext
# iOS accepts at most 825 days for any TLS server certificate
openssl x509 -req -in $T/req.csr -CA $CA/ca.pem -CAkey $CA/ca.key -set_serial 0x$(openssl rand -hex 16) \
  -days 800 -sha256 -extfile $T/ext -out $T/cert.pem
install -o msg -g msg -m 600 $T/key.pem $D/key.pem
install -o msg -g msg -m 644 $T/cert.pem $D/cert.pem
rm -rf $T
echo "web certificate issued for $IP"
CERT
chmod 755 /usr/local/sbin/sepan-web-cert
echo "$IP" > /opt/messenger/web-ip
/usr/local/sbin/sepan-web-cert
printf '# renew the web (port 443) certificate before it expires\n17 4 * * * root /usr/local/sbin/sepan-web-cert >/dev/null\n' > /etc/cron.d/sepan-web-cert

chown -R msg:msg /opt/messenger/certs
chmod 700 /opt/messenger/certs; chmod 600 /opt/messenger/certs/key.pem
chmod 755 /opt/messenger/certs/web; chmod 600 /opt/messenger/certs/web/key.pem

# --- admin helper ---
cat > /usr/local/bin/msgadmin <<'ADM'
#!/bin/bash
exec runuser -u msg -- env DATA_DIR=/opt/messenger/data /usr/bin/node --disable-warning=ExperimentalWarning /opt/messenger/app/cli.js "$@"
ADM
chmod +x /usr/local/bin/msgadmin

# --- STUN/TURN server (coturn) for voice/video calls ---
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
apt-get update -y
apt-get install -y coturn

# shared secret between coturn and the messenger server (time-limited credentials)
SECRET_FILE=/opt/messenger/certs/turn_secret
[ -f "$SECRET_FILE" ] || openssl rand -hex 32 > "$SECRET_FILE"
chown msg:msg "$SECRET_FILE"; chmod 600 "$SECRET_FILE"
SECRET="$(cat "$SECRET_FILE")"

cat > /etc/turnserver.conf <<CONF
listening-port=3478
listening-ip=0.0.0.0
external-ip=$IP
min-port=49152
max-port=49352
fingerprint
use-auth-secret
static-auth-secret=$SECRET
realm=messenger
total-quota=100
no-tls
no-dtls
no-cli
no-multicast-peers
no-software-attribute
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
CONF
chown root:turnserver /etc/turnserver.conf; chmod 640 /etc/turnserver.conf
echo 'TURNSERVER_ENABLED=1' > /etc/default/coturn

ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 49152:49352/udp
ufw allow 443/tcp   # web version (iPhone)
ufw allow 80/tcp    # web setup page (CA profile) + redirect to https

systemctl enable coturn >/dev/null 2>&1
systemctl restart coturn

# --- systemd service ---
cat > /etc/systemd/system/messenger.service <<'UNIT'
[Unit]
Description=Private messenger server
After=network.target

[Service]
User=msg
Group=msg
WorkingDirectory=/opt/messenger/app
Environment=DATA_DIR=/opt/messenger/data CERT_DIR=/opt/messenger/certs PORT=8443
Environment=MAX_FILE_MB=25 MAX_TOTAL_MB=10000 FILE_TTL_DAYS=30 MSG_TTL_DAYS=90
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/messenger/app/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/messenger/data
MemoryMax=450M
# lets the unprivileged msg user serve the web version on ports 443 and 80
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

mkdir -p /etc/systemd/system/messenger.service.d
cat > /etc/systemd/system/messenger.service.d/turn.conf <<UNIT
[Service]
Environment=TURN_SECRET_FILE=/opt/messenger/certs/turn_secret PUBLIC_HOST=$IP
UNIT

# --- admin panel exposure ---
case "$MODE" in
  local)
    rm -f /etc/systemd/system/messenger.service.d/admin.conf
    ufw delete allow 8444/tcp >/dev/null 2>&1 || true
    ;;
  open)
    printf '[Service]\nEnvironment=ADMIN_BIND=0.0.0.0\n' > /etc/systemd/system/messenger.service.d/admin.conf
    ufw limit 8444/tcp   # allowed from anywhere, but max ~6 new connections / 30 s per IP
    ;;
  *)
    printf '[Service]\nEnvironment=ADMIN_BIND=0.0.0.0\n' > /etc/systemd/system/messenger.service.d/admin.conf
    ufw allow from "$MODE" to any port 8444 proto tcp
    ;;
esac

chown -R msg:msg $APP /opt/messenger/data
systemctl daemon-reload
systemctl enable messenger >/dev/null 2>&1
systemctl restart messenger
sleep 3

# --- first-time admin panel password ---
NEWPW=""
if [ ! -f /opt/messenger/data/.admin_pw_created ]; then
  NEWPW="$(msgadmin adminpw | head -2)"
  touch /opt/messenger/data/.admin_pw_created
  chown msg:msg /opt/messenger/data/.admin_pw_created
fi

echo
echo "=============== RESULT ==============="
echo -n "messenger service: "; systemctl is-active messenger
echo -n "coturn:            "; systemctl is-active coturn
echo -n "health:            "; curl -sk https://127.0.0.1:8443/api/health || echo "health check FAILED"; echo
echo -n "web version:       "; curl -s --cacert /opt/messenger/ca/ca.pem --resolve "$IP:443:127.0.0.1" "https://$IP/api/health" || echo "web health check FAILED"; echo
echo "listening:"; ss -ltn | grep -E ':8443|:8444|:443 |:80 ' || echo "NOT LISTENING"
echo "TURN listening sockets:"
ss -lunpt | grep 3478 || echo "NOT LISTENING on 3478"
ufw status | grep -E "3478|49152" || true
echo -n "users in database: "; msgadmin list | wc -l
echo
echo "Certificate fingerprint (SHA-256) - needed for the Android app:"
openssl x509 -in /opt/messenger/certs/cert.pem -noout -fingerprint -sha256
echo
if [ -n "$NEWPW" ]; then echo "$NEWPW"; echo "(save this password now - it is shown only once)"; else echo "Admin panel password unchanged (reset with: msgadmin adminpw). Username: admin unless you changed it in the panel"; fi
echo
case "$MODE" in
  local) echo "Admin panel: only from the server. Use an SSH tunnel (Bitvise C2S: 127.0.0.1:8444 -> 127.0.0.1:8444), then open https://127.0.0.1:8444" ;;
  open)  echo "Admin panel: https://$IP:8444   (accept the certificate warning; open to the Internet)" ;;
  *)     echo "Admin panel: https://$IP:8444   (allowed only from $MODE)" ;;
esac
echo
echo "Web version (iPhone): first open  http://$IP/setup  in Safari and install the profile, then  https://$IP/"
echo -n "Sepan Root CA fingerprint (SHA-256): "; openssl x509 -in /opt/messenger/ca/ca.pem -noout -fingerprint -sha256 | cut -d= -f2
echo
echo "Create users with:  msgadmin add USERNAME"
if [ -n "$SAFE" ]; then
  echo
  echo "To roll back:  systemctl stop messenger; rm -rf /opt/messenger/app; cp -a $SAFE/app /opt/messenger/app; cp -a $SAFE/messenger.db* /opt/messenger/data/; systemctl start messenger"
fi
