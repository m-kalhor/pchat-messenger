#!/bin/bash
# Sepan server installer (1.25) for a NEW Ubuntu 22.04 / 24.04 server (x86_64), from the packaged release
# (tools/package: one protected executable + web files). Run as root from the unpacked folder:
#
#   tar xzf sepan-server-X.Y.Z.tar.gz && sudo bash sepan-server-X.Y.Z/sepan-setup.sh
#
# It asks for the settings (app name, server address, domain, admin account, SMS provider, ...), shows a
# REQUEST CODE that the owner turns into an ACTIVATION CODE on his own computer (tools/license), and only then
# installs: the server, coturn (calls), the firewall, fail2ban, certificates, the admin panel and the web version.
# At the end it prints the addresses and a BUILD CODE for the customer's own Android app (GitHub "Customer APK").
#
# Run again later with a newer package to upgrade: the saved answers and the database are kept (a backup is made),
# and a new activation code is needed for the new version.
#
# Options:  --answers FILE   read the answers from FILE (VAR=value lines, see the end of this file) instead of asking
#           --activation CODE   use this activation code instead of asking for it
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_APP="$HERE/app"
BIN="$PKG_APP/sepan-server"
PKG_VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo '?')"
CONF=/root/sepan-setup.conf
INFO=/root/sepan-info.txt
ANSWERS=""
ACTIVATION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --answers) ANSWERS="${2:-}"; shift 2 ;;
    --activation) ACTIVATION="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------- helpers
B=$'\e[1m'; G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; N=$'\e[0m'
say()  { echo -e "$*"; }
step() { echo; echo "${B}${C}== $* ==${N}"; }
ok()   { echo "${G}OK${N} $*"; }
warn() { echo "${Y}WARNING${N} $*"; }
die()  { echo "${R}ERROR${N} $*"; exit 1; }
# ask VAR "English / فارسی" default   (the current value of VAR, if any, is the default)
ask() {
  local var="$1" q="$2" def="${3:-}" cur="${!1:-}" a
  [ -n "$cur" ] && def="$cur"
  if [ -n "$ANSWERS" ]; then printf -v "$var" '%s' "$def"; echo "$q: $def"; return; fi
  read -r -p "${B}$q${N}${def:+ [$def]}: " a
  printf -v "$var" '%s' "${a:-$def}"
}
ask_secret() {
  local var="$1" q="$2" a
  if [ -n "$ANSWERS" ]; then echo "$q: (from answers file)"; return; fi
  read -r -s -p "${B}$q${N}: " a; echo
  printf -v "$var" '%s' "$a"
}
ask_yn() { # ask_yn VAR "question" y|n
  local var="$1" q="$2" def="${3:-n}" cur="${!1:-}" a
  [ -n "$cur" ] && def="$cur"
  if [ -n "$ANSWERS" ]; then printf -v "$var" '%s' "$def"; echo "$q: $def"; return; fi
  while true; do
    read -r -p "${B}$q${N} [y/n, $def]: " a; a="${a:-$def}"
    case "$a" in y|Y|yes) printf -v "$var" y; return ;; n|N|no) printf -v "$var" n; return ;; esac
  done
}
valid_ip() { [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] && for o in "${BASH_REMATCH[@]:1}"; do [ "$o" -le 255 ] || return 1; done; }
private_ip() { [[ "$1" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]; }

# ---------------------------------------------------------------- checks
[ "$(id -u)" = 0 ] || die "Run as root (sudo bash $0)"
[ -x "$BIN" ] || die "The server program was not found in $PKG_APP (unpack the whole package and run sepan-setup.sh from it)"
[ "$(uname -m)" = x86_64 ] || die "Only x86_64 (amd64) servers are supported"
. /etc/os-release 2>/dev/null || true
if [ "${ID:-}" != ubuntu ] || ! [[ "${VERSION_ID:-}" =~ ^(22\.04|24\.04)$ ]]; then
  warn "Tested on Ubuntu 22.04 and 24.04; this is ${PRETTY_NAME:-unknown}."
  [ -n "$ANSWERS" ] || { read -r -p "Continue anyway? [y/N] " a; [[ "$a" =~ ^[yY] ]] || exit 1; }
fi
command -v systemctl >/dev/null || die "systemd is required"
if [ -f /opt/messenger/app/server.js ] && [ ! -f /opt/messenger/app/sepan-server ]; then
  die "This server runs a source install of Sepan (install.sh). Upgrade it with install.sh, not with this package."
fi

UPGRADE=n
GEN_PASS=n
[ -f /opt/messenger/app/sepan-server ] && UPGRADE=y
# saved answers of an earlier run (no secrets in it)
[ -f "$CONF" ] && . "$CONF"
[ -n "$ANSWERS" ] && { [ -f "$ANSWERS" ] || die "answers file not found: $ANSWERS"; . "$ANSWERS"; }

clear 2>/dev/null || true
say "${B}Sepan server installer $PKG_VERSION${N}"
say "نصب‌کنندهٔ سرور سپن — نسخهٔ $PKG_VERSION"
[ $UPGRADE = y ] && say "${Y}Existing installation found: it will be UPGRADED (database kept, backup made).${N}"

# ---------------------------------------------------------------- questions
step "1/3  Settings / تنظیمات"
if [ $UPGRADE = y ] && [ -n "${APP_NAME:-}" ] && [ -z "$ANSWERS" ]; then
  say "Saved settings from $CONF are used. (Delete that file to answer everything again.)"
  KEEP=y
else
  KEEP=n
fi

if [ $KEEP = n ]; then
  say "Press Enter to keep the value in [brackets].  /  برای پذیرفتن مقدار داخل [ ] فقط Enter بزنید."
  echo
  ask APP_NAME "App name (shown to users)  /  نام برنامه" "سپن"
  while :; do
    ask APP_ID "Short English id of this customer (a-z, 0-9; used in the Android package name)  /  شناسهٔ لاتین مشتری" "${APP_ID:-}"
    [[ "$APP_ID" =~ ^[a-z][a-z0-9]{1,19}$ ]] && break; echo "2-20 characters: a-z then a-z/0-9"; APP_ID=""; [ -n "$ANSWERS" ] && die "bad APP_ID"
  done

  DET_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
  if [ -z "${SERVER_IP:-}" ] && { [ -z "$DET_IP" ] || private_ip "$DET_IP"; }; then
    PUB="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    valid_ip "$PUB" && DET_IP="$PUB"
  fi
  while :; do
    ask SERVER_IP "Public IP address of this server  /  آی‌پی عمومی سرور" "$DET_IP"
    valid_ip "$SERVER_IP" && break; echo "Not an IPv4 address"; SERVER_IP=""; [ -n "$ANSWERS" ] && die "bad SERVER_IP"
  done

  say "A domain name (optional) gives the web version a real certificate and enables calls over TLS (port 5349)."
  say "Its A record must already point at $SERVER_IP (Cloudflare: DNS only / grey cloud). Leave empty for none."
  ask DOMAIN "Domain name, e.g. chat.example.ir (optional)  /  دامنه (اختیاری)" "${DOMAIN:-}"
  DOMAIN="$(echo "$DOMAIN" | tr 'A-Z' 'a-z' | sed 's#^https\?://##; s#/.*##')"
  if [ -n "$DOMAIN" ]; then
    [[ "$DOMAIN" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || die "Not a domain name: $DOMAIN"
    ask LE_EMAIL "E-mail for Let's Encrypt notices (optional)  /  ایمیل (اختیاری)" "${LE_EMAIL:-}"
  else LE_EMAIL=""; fi

  ask ADMIN_USER "Admin panel username  /  نام کاربری مدیر" "${ADMIN_USER:-admin}"
  [[ "$ADMIN_USER" =~ ^[a-z0-9_.-]{3,32}$ ]] || die "Admin username: 3-32 characters of a-z 0-9 _ . -"
  if [ -z "${ADMIN_PASS:-}" ]; then
    while :; do
      ask_secret ADMIN_PASS "Admin panel password (min 8; Enter = make a random one)  /  رمز مدیر"
      [ -z "$ADMIN_PASS" ] && break
      [ ${#ADMIN_PASS} -ge 8 ] || { echo "At least 8 characters"; continue; }
      ask_secret ADMIN_PASS2 "Repeat the password  /  تکرار رمز"
      [ "$ADMIN_PASS" = "$ADMIN_PASS2" ] && break; echo "The two passwords differ"
    done
  fi
  GEN_PASS=n
  [ -z "${ADMIN_PASS:-}" ] && { ADMIN_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"; GEN_PASS=y; }

  say "Who may open the admin panel (port ${ADMIN_PORT:-8444})?  /  دسترسی به پنل مدیر"
  say "  1) from anywhere (password + rate limit)   2) only from one IP address   3) only from the server (SSH tunnel)"
  ask ADMIN_ACCESS_N "Choose 1, 2 or 3" "${ADMIN_ACCESS_N:-1}"
  case "$ADMIN_ACCESS_N" in
    1) ADMIN_MODE=open ;;
    2) ask ADMIN_FROM_IP "The IP address allowed to open the panel" "${ADMIN_FROM_IP:-}"; valid_ip "$ADMIN_FROM_IP" || die "Not an IPv4 address"; ADMIN_MODE="$ADMIN_FROM_IP" ;;
    3) ADMIN_MODE=local ;;
    *) die "Choose 1, 2 or 3" ;;
  esac

  say "Sign-in code by SMS (OTP)  /  پیامک کد ورود"
  say "  1) Arta Payamak (IPPanel Edge)   2) none now (set it later in the admin panel, «پیامک» tab)"
  ask SMS_N "Choose 1 or 2" "${SMS_N:-1}"
  if [ "$SMS_N" = 1 ]; then
    SMS_PROVIDER=artapayamak
    [ -n "${SMS_TOKEN:-}" ] || ask_secret SMS_TOKEN "Arta Payamak API token  /  توکن API"
    ask SMS_FROM "Sending line number, e.g. +983000505  /  شمارهٔ خط ارسال" "${SMS_FROM:-}"
    ask SMS_PATTERN "Pattern code (approved pattern with one variable)  /  کد الگو (پترن)" "${SMS_PATTERN:-}"
    ask SMS_PARAM "Name of the code variable in the pattern  /  نام متغیر کد" "${SMS_PARAM:-code}"
    ask SMS_TEST "Mobile number for a test SMS at the end, e.g. 09121234567 (optional)  /  شماره برای پیامک آزمایشی" "${SMS_TEST:-}"
  else SMS_PROVIDER=""; fi

  DEF_SIGNUP=n; [ -n "$SMS_PROVIDER" ] && DEF_SIGNUP=y
  ask_yn OPEN_SIGNUP "Let people make their own account with their mobile number?  /  ثبت‌نام آزاد" "${OPEN_SIGNUP:-$DEF_SIGNUP}"
  ask_yn GROUP_CALLS "Turn on group voice calls?  /  تماس گروهی" "${GROUP_CALLS:-y}"

  ask_yn CHANGE_PORTS "Change the ports (Android app 8443, admin panel 8444)?  /  تغییر پورت‌ها" "n"
  if [ "$CHANGE_PORTS" = y ]; then
    ask APP_PORT "Port of the Android app" "${APP_PORT:-8443}"
    ask ADMIN_PORT "Port of the admin panel" "${ADMIN_PORT:-8444}"
  fi
fi
APP_PORT="${APP_PORT:-8443}"; ADMIN_PORT="${ADMIN_PORT:-8444}"
for p in "$APP_PORT" "$ADMIN_PORT"; do
  [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -ge 1024 ] && [ "$p" -le 65000 ] || die "Port $p: use 1024-65000"
  case "$p" in 3478|5349|8080) die "Port $p is used by something else" ;; esac
done
[ "$APP_PORT" != "$ADMIN_PORT" ] || die "The two ports must differ"

echo
say "${B}Summary / خلاصه${N}"
say "  App name ............ $APP_NAME   (id: $APP_ID)"
say "  Server address ...... $SERVER_IP${DOMAIN:+   domain: $DOMAIN}"
say "  Admin panel ......... user $ADMIN_USER, port $ADMIN_PORT, access: $ADMIN_MODE"
say "  SMS ................. ${SMS_PROVIDER:-later in the panel}"
say "  Open sign-up ........ $OPEN_SIGNUP     group calls: $GROUP_CALLS"
say "  Ports ............... app $APP_PORT, admin $ADMIN_PORT, web 443/80, calls 3478 + 5349 + UDP 49152-49352"
if [ -z "$ANSWERS" ]; then
  read -r -p "${B}Continue? / ادامه؟${N} [Y/n] " a; [[ "${a:-y}" =~ ^[yY] ]] || exit 1
fi

# saved for the next run (upgrade); the secrets (passwords, SMS token) are not written
umask 077
cat > "$CONF" <<EOF
# Sepan installer answers ($(date -u +%F)); no passwords in here
APP_NAME='${APP_NAME//\'/}'
APP_ID='$APP_ID'
SERVER_IP='$SERVER_IP'
DOMAIN='$DOMAIN'
LE_EMAIL='$LE_EMAIL'
ADMIN_USER='$ADMIN_USER'
ADMIN_ACCESS_N='$ADMIN_ACCESS_N'
ADMIN_FROM_IP='${ADMIN_FROM_IP:-}'
ADMIN_MODE='$ADMIN_MODE'
SMS_N='$SMS_N'
SMS_PROVIDER='$SMS_PROVIDER'
SMS_FROM='${SMS_FROM:-}'
SMS_PATTERN='${SMS_PATTERN:-}'
SMS_PARAM='${SMS_PARAM:-}'
OPEN_SIGNUP='$OPEN_SIGNUP'
GROUP_CALLS='$GROUP_CALLS'
APP_PORT='$APP_PORT'
ADMIN_PORT='$ADMIN_PORT'
EOF
umask 022

# ---------------------------------------------------------------- owner's approval
step "2/3  Approval / تأیید نصب"
REQ="$("$BIN" license request --ip "$SERVER_IP" --app "$APP_NAME" --id "$APP_ID")" || die "Could not make the request code"
LIC_TMP="$(mktemp)"
say "Send this REQUEST CODE to the owner of Sepan. He sends back an ACTIVATION CODE."
say "این «کد درخواست» را برای صاحب سپن بفرستید تا «کد فعال‌سازی» را بفرستد."
echo
echo "${B}${G}$REQ${N}"
echo
echo "$REQ" > /root/sepan-request-code.txt
say "(also saved in /root/sepan-request-code.txt)"
while :; do
  if [ -n "$ACTIVATION" ]; then CODE="$ACTIVATION"; else read -r -p "${B}Activation code / کد فعال‌سازی${N} (q = quit): " CODE; fi
  CODE="$(echo "$CODE" | tr -d '[:space:]')"
  [ "$CODE" = q ] && { say "Stopped. Nothing was installed. Run the installer again when you have the code."; exit 1; }
  if "$BIN" license activate --code "$CODE" --ip "$SERVER_IP" --out "$LIC_TMP"; then break; fi
  [ -n "$ACTIVATION" ] && die "The activation code was not accepted"
  say "Not accepted, try again. / پذیرفته نشد؛ دوباره بزنید."
done
ok "approved"

# ---------------------------------------------------------------- install
step "3/3  Installing / نصب"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
apt-get update -y >/dev/null || warn "apt-get update failed"
PKGS="coturn ufw fail2ban openssl curl ca-certificates python3 traceroute"
[ -n "$DOMAIN" ] && PKGS="$PKGS certbot"
# shellcheck disable=SC2086
apt-get install -y $PKGS >/dev/null || die "Installing packages failed: $PKGS"
ok "packages: $PKGS"

id msg >/dev/null 2>&1 || adduser --system --group --home /opt/messenger msg >/dev/null
APP=/opt/messenger/app
mkdir -p /opt/messenger/data/files /opt/messenger/data/apk /opt/messenger/certs

SAFE=""
if [ -d $APP ]; then
  SAFE=/root/messenger-backup-$(date +%Y%m%d-%H%M%S)
  mkdir -p "$SAFE"
  systemctl stop messenger 2>/dev/null || true
  cp -a $APP "$SAFE/app"
  cp -a /opt/messenger/data/messenger.db* /opt/messenger/data/license.txt "$SAFE/" 2>/dev/null || true
  ok "old version + database saved in $SAFE"
fi
rm -rf $APP.new && cp -a "$PKG_APP" $APP.new && rm -rf $APP && mv $APP.new $APP
install -o msg -g msg -m 644 "$LIC_TMP" /opt/messenger/data/license.txt; rm -f "$LIC_TMP"
ok "server program $PKG_VERSION"

# --- certificate of the Android app port (self-signed, 10 years, pinned inside the customer's APK) ---
if [ ! -f /opt/messenger/certs/key.pem ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout /opt/messenger/certs/key.pem -out /opt/messenger/certs/cert.pem -days 3650 \
    -subj "/CN=messenger" -addext "subjectAltName=IP:$SERVER_IP" 2>/dev/null
fi

# --- web version: private root CA + certificate for port 443 (iPhones install the CA once at http://IP/setup) ---
CA_DIR=/opt/messenger/ca
mkdir -p $CA_DIR /opt/messenger/certs/web; chmod 700 $CA_DIR
if [ ! -f $CA_DIR/ca.key ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout $CA_DIR/ca.key -out $CA_DIR/ca.pem -days 3650 -subj "/CN=$APP_ID Root CA/O=$APP_ID" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi
chmod 600 $CA_DIR/ca.key
cp $CA_DIR/ca.pem /opt/messenger/certs/web/ca.pem
cat > /usr/local/sbin/sepan-web-cert <<'CERT'
#!/bin/bash
# Issues or renews the web (port 443) certificate from the private root CA when it is missing, expires within
# 30 days or does not match the server IP. A certificate from another CA (Let's Encrypt) is left alone.
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
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout $T/key.pem -out $T/req.csr -subj "/CN=$IP" 2>/dev/null
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:%s\n' "$IP" > $T/ext
openssl x509 -req -in $T/req.csr -CA $CA/ca.pem -CAkey $CA/ca.key -set_serial 0x$(openssl rand -hex 16) \
  -days 800 -sha256 -extfile $T/ext -out $T/cert.pem 2>/dev/null
install -o msg -g msg -m 600 $T/key.pem $D/key.pem
install -o msg -g msg -m 644 $T/cert.pem $D/cert.pem
rm -rf $T
CERT
chmod 755 /usr/local/sbin/sepan-web-cert
echo "$SERVER_IP" > /opt/messenger/web-ip
/usr/local/sbin/sepan-web-cert
printf '# renew the web (port 443) certificate before it expires\n17 4 * * * root /usr/local/sbin/sepan-web-cert >/dev/null\n' > /etc/cron.d/sepan-web-cert
chown -R msg:msg /opt/messenger/certs
chmod 700 /opt/messenger/certs; chmod 600 /opt/messenger/certs/key.pem
chmod 755 /opt/messenger/certs/web; chmod 600 /opt/messenger/certs/web/key.pem
ok "certificates"

# --- admin command line + APK helper ---
cat > /usr/local/bin/msgadmin <<'ADM'
#!/bin/bash
exec runuser -u msg -- env DATA_DIR=/opt/messenger/data NODE_NO_WARNINGS=1 /opt/messenger/app/sepan-server cli "$@"
ADM
chmod 755 /usr/local/bin/msgadmin
cat > /usr/local/bin/sepan-apk <<'APK'
#!/bin/bash
# Puts the customer's APK on this server for download and in-app updates:
#   sepan-apk app FILE.apk      the messenger app
#   sepan-apk admin FILE.apk    the admin app
set -euo pipefail
case "${1:-}" in app) T=sepan.apk ;; admin) T=sepan-admin.apk ;; *) echo "usage: sepan-apk app|admin FILE.apk"; exit 1 ;; esac
[ -f "${2:-}" ] || { echo "file not found: ${2:-}"; exit 1; }
unzip -l "$2" AndroidManifest.xml >/dev/null 2>&1 || head -c 2 "$2" | grep -q PK || { echo "not an APK"; exit 1; }
install -o msg -g msg -m 644 "$2" /opt/messenger/data/apk/$T.new && mv /opt/messenger/data/apk/$T.new /opt/messenger/data/apk/$T
echo "OK: /opt/messenger/data/apk/$T"
APK
chmod 755 /usr/local/bin/sepan-apk
chown -R msg:msg /opt/messenger/data /opt/messenger/app

# --- settings from the answers (written before the server starts; secrets go through stdin, not the command line) ---
export APP_NAME ADMIN_USER ADMIN_PASS OPEN_SIGNUP GROUP_CALLS SMS_PROVIDER
export SMS_TOKEN="${SMS_TOKEN:-}" SMS_FROM="${SMS_FROM:-}" SMS_PATTERN="${SMS_PATTERN:-}" SMS_PARAM="${SMS_PARAM:-}" KEEP
python3 - <<'PY' | msgadmin setup || die "Saving the settings failed"
import json, os
e = os.environ
a = {"app_name": e["APP_NAME"], "admin_user": e["ADMIN_USER"]}
if e.get("ADMIN_PASS"): a["admin_pass"] = e["ADMIN_PASS"]
if e["KEEP"] != "y":
    a["open_signup"] = e["OPEN_SIGNUP"] == "y"
    a["group_calls"] = e["GROUP_CALLS"] == "y"
    if e.get("SMS_PROVIDER"):
        v = {"from": e["SMS_FROM"], "pattern": e["SMS_PATTERN"], "param": e["SMS_PARAM"] or "code"}
        if e.get("SMS_TOKEN"): v["token"] = e["SMS_TOKEN"]
        a["sms"] = {"provider": e["SMS_PROVIDER"], "values": v}
print(json.dumps(a))
PY
touch /opt/messenger/data/.admin_pw_created; chown msg:msg /opt/messenger/data/.admin_pw_created

# --- coturn (STUN/TURN for calls); TURN over TLS on 5349 only with a Let's Encrypt domain ---
LOCAL_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
EXT_IP="$SERVER_IP"
[ -n "$LOCAL_IP" ] && [ "$LOCAL_IP" != "$SERVER_IP" ] && EXT_IP="$SERVER_IP/$LOCAL_IP"   # behind NAT
SECRET_FILE=/opt/messenger/certs/turn_secret
[ -f "$SECRET_FILE" ] || openssl rand -hex 32 > "$SECRET_FILE"
chown msg:msg "$SECRET_FILE"; chmod 600 "$SECRET_FILE"
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
TURN_TLS_HOST=""
configure_turn() {
  local tls_conf="no-tls" TC=/etc/coturn/sepan-turn
  if [ -n "$TURN_TLS_HOST" ]; then
    mkdir -p /etc/coturn /etc/letsencrypt/renewal-hooks/deploy
    cat > /etc/letsencrypt/renewal-hooks/deploy/sepan-turn.sh <<'HOOKEOF'
#!/bin/bash
# installed by sepan-setup.sh: give coturn the renewed certificate for TURN over TLS
set -e
N=$(basename "$RENEWED_LINEAGE")
grep -q "^cert=/etc/coturn/sepan-turn.pem" /etc/turnserver.conf 2>/dev/null || exit 0
grep -q "TURN_TLS_HOST=$N" /etc/systemd/system/messenger.service.d/turn.conf 2>/dev/null || exit 0
install -o root -g turnserver -m 644 "$RENEWED_LINEAGE/fullchain.pem" /etc/coturn/sepan-turn.pem
install -o root -g turnserver -m 640 "$RENEWED_LINEAGE/privkey.pem" /etc/coturn/sepan-turn.key
systemctl restart coturn || true
HOOKEOF
    chmod 755 /etc/letsencrypt/renewal-hooks/deploy/sepan-turn.sh
    install -o root -g turnserver -m 644 "/opt/messenger/certs/le/$TURN_TLS_HOST/cert.pem" $TC.pem
    install -o root -g turnserver -m 640 "/opt/messenger/certs/le/$TURN_TLS_HOST/key.pem" $TC.key
    tls_conf="tls-listening-port=5349
cert=$TC.pem
pkey=$TC.key
no-tlsv1
no-tlsv1_1"
  fi
  cat > /etc/turnserver.conf <<CONF
listening-port=3478
listening-ip=0.0.0.0
external-ip=$EXT_IP
min-port=49152
max-port=49352
fingerprint
use-auth-secret
static-auth-secret=$(cat $SECRET_FILE)
realm=messenger
total-quota=100
$tls_conf
no-dtls
no-cli
no-multicast-peers
no-software-attribute
log-file=/var/log/sepan-turn/turn.log
simple-log
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
  mkdir -p /etc/systemd/system/messenger.service.d
  {
    echo "[Service]"
    echo "Environment=TURN_SECRET_FILE=/opt/messenger/certs/turn_secret PUBLIC_HOST=$SERVER_IP${TURN_TLS_HOST:+ TURN_TLS_HOST=$TURN_TLS_HOST TURN_TLS_PORT=5349}"
    echo "Environment=TURN_LOG_FILE=/var/log/sepan-turn/turn.log"
  } > /etc/systemd/system/messenger.service.d/turn.conf
  systemctl enable coturn >/dev/null 2>&1
  systemctl restart coturn
}
configure_turn
ok "coturn (calls)"

# --- firewall: SSH stays open first, then everything the server needs ---
SSH_PORTS="$(ss -ltnpH 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]}' | sort -u)"
[ -n "$SSH_PORTS" ] || SSH_PORTS=22
for p in $SSH_PORTS; do ufw allow "$p"/tcp >/dev/null; done
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw allow "$APP_PORT"/tcp >/dev/null
ufw allow 3478/udp >/dev/null; ufw allow 3478/tcp >/dev/null; ufw allow 5349/tcp >/dev/null
ufw allow 49152:49352/udp >/dev/null
ufw delete allow "$ADMIN_PORT"/tcp >/dev/null 2>&1 || true
ufw delete limit "$ADMIN_PORT"/tcp >/dev/null 2>&1 || true
mkdir -p /etc/systemd/system/messenger.service.d
case "$ADMIN_MODE" in
  local) rm -f /etc/systemd/system/messenger.service.d/admin.conf ;;
  open)  printf '[Service]\nEnvironment=ADMIN_BIND=0.0.0.0\n' > /etc/systemd/system/messenger.service.d/admin.conf
         ufw limit "$ADMIN_PORT"/tcp >/dev/null ;;
  *)     printf '[Service]\nEnvironment=ADMIN_BIND=0.0.0.0\n' > /etc/systemd/system/messenger.service.d/admin.conf
         ufw allow from "$ADMIN_MODE" to any port "$ADMIN_PORT" proto tcp >/dev/null ;;
esac
ufw --force enable >/dev/null && ok "firewall (SSH port(s) $SSH_PORTS kept open)"
systemctl enable --now fail2ban >/dev/null 2>&1 && ok "fail2ban (SSH brute-force protection)"

# --- service ---
cat > /etc/systemd/system/messenger.service <<UNIT
[Unit]
Description=$APP_ID messenger server (Sepan $PKG_VERSION)
After=network.target

[Service]
User=msg
Group=msg
WorkingDirectory=/opt/messenger/app
Environment=DATA_DIR=/opt/messenger/data CERT_DIR=/opt/messenger/certs PORT=$APP_PORT ADMIN_PORT=$ADMIN_PORT PUBLIC_HOST=$SERVER_IP
Environment=MAX_FILE_MB=25 MAX_TOTAL_MB=10000 FILE_TTL_DAYS=30 MSG_TTL_DAYS=90
ExecStart=/opt/messenger/app/sepan-server
Restart=always
RestartSec=2
# 78 = no valid activation: do not restart in a loop
RestartPreventExitStatus=78
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/messenger/data
MemoryMax=450M
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable messenger >/dev/null 2>&1
systemctl restart messenger
for i in $(seq 1 20); do curl -sk --max-time 2 "https://127.0.0.1:$APP_PORT/api/health" >/dev/null && break; sleep 1; done
if curl -sk --max-time 3 "https://127.0.0.1:$APP_PORT/api/health" >/dev/null; then ok "messenger service"
else journalctl -u messenger -n 20 --no-pager; die "The messenger service did not start (see above)"; fi

# --- domain: Let's Encrypt certificate (web version) + TURN over TLS ---
if [ -n "$DOMAIN" ]; then
  if bash "$HERE/domain.sh" "$DOMAIN" "$LE_EMAIL"; then
    if [ -f "/opt/messenger/certs/le/$DOMAIN/cert.pem" ]; then
      TURN_TLS_HOST="$DOMAIN"; configure_turn; systemctl daemon-reload; systemctl restart messenger; sleep 2
      ok "domain $DOMAIN + TURN over TLS"
    fi
  else
    warn "The domain certificate failed (DNS not pointing here yet?). Later: bash $HERE/domain.sh $DOMAIN, then run this installer again."
  fi
fi

# --- test SMS ---
SMS_RESULT=""
if [ -n "$SMS_PROVIDER" ] && [ -n "${SMS_TEST:-}" ]; then
  T="$(echo "$SMS_TEST" | tr -d ' -')"
  [[ "$T" =~ ^0 ]] && T="+98${T:1}"
  [[ "$T" =~ ^98 ]] && T="+$T"
  if msgadmin sms-test "$T"; then SMS_RESULT="test SMS sent to $T"; else SMS_RESULT="TEST SMS FAILED (check the SMS settings in the admin panel)"; fi
fi

# ---------------------------------------------------------------- result
BUILD_CODE="$(APP_NAME="$APP_NAME" APP_ID="$APP_ID" SERVER_IP="$SERVER_IP" APP_PORT="$APP_PORT" ADMIN_PORT="$ADMIN_PORT" python3 - <<'PY'
import base64, json, os
e = os.environ
pem = open("/opt/messenger/certs/cert.pem").read()
d = {"v": 1, "n": e["APP_NAME"], "id": e["APP_ID"], "h": e["SERVER_IP"], "p": int(e["APP_PORT"]), "a": int(e["ADMIN_PORT"]), "c": pem}
print("SB1." + base64.urlsafe_b64encode(json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode()).decode().rstrip("="))
PY
)"
FP="$(openssl x509 -in /opt/messenger/certs/cert.pem -noout -fingerprint -sha256 | cut -d= -f2)"
WEB="https://$SERVER_IP/"; [ -n "$DOMAIN" ] && WEB="https://$DOMAIN/app"
case "$ADMIN_MODE" in
  local) PANEL="only from the server: SSH tunnel 127.0.0.1:$ADMIN_PORT, then https://127.0.0.1:$ADMIN_PORT" ;;
  *)     PANEL="https://$SERVER_IP:$ADMIN_PORT  (accept the certificate warning)" ;;
esac

umask 077
{
  echo "Sepan $PKG_VERSION on $SERVER_IP - installed $(date '+%F %T')"
  echo "App name:        $APP_NAME ($APP_ID)"
  echo "Admin panel:     $PANEL"
  echo "Admin username:  $ADMIN_USER"
  [ "$GEN_PASS" = y ] && echo "Admin password:  $ADMIN_PASS"
  echo "Web version:     $WEB   (iPhone without a domain: first http://$SERVER_IP/setup)"
  echo "Android port:    $APP_PORT   certificate SHA-256: $FP"
  echo "SMS:             ${SMS_PROVIDER:-not set (admin panel)} ${SMS_RESULT}"
  echo
  echo "BUILD CODE for the customer's Android apps (GitHub: Actions > Customer APK > Run workflow):"
  echo "$BUILD_CODE"
  echo
  echo "Put the built APKs here:  sepan-apk app FILE.apk   and   sepan-apk admin FILE.apk"
  echo "Users:  msgadmin add NAME  |  msgadmin list  |  license: msgadmin license status"
  [ -n "$SAFE" ] && echo "Backup of the previous version: $SAFE"
} > "$INFO"
umask 022

echo
echo "${B}${G}=============== DONE / نصب تمام شد ===============${N}"
echo -n "messenger: "; systemctl is-active messenger
echo -n "coturn:    "; systemctl is-active coturn
echo -n "license:   "; msgadmin license status | cut -c1-60
cat "$INFO"
echo
say "${Y}Everything above is saved in $INFO (readable by root only).${N}"
[ "$GEN_PASS" = y ] && say "${Y}Write down the admin password now.${N}"
exit 0

# ---------------------------------------------------------------- answers file (for --answers)
# APP_NAME='سپن'  APP_ID=acme  SERVER_IP=1.2.3.4  DOMAIN=  LE_EMAIL=
# ADMIN_USER=admin  ADMIN_PASS='...'  ADMIN_ACCESS_N=1 (2 + ADMIN_FROM_IP=..., 3)
# SMS_N=1  SMS_TOKEN='...'  SMS_FROM=+983000505  SMS_PATTERN=...  SMS_PARAM=code  SMS_TEST=0912...   (SMS_N=2: none)
# OPEN_SIGNUP=y  GROUP_CALLS=y  APP_PORT=8443  ADMIN_PORT=8444
