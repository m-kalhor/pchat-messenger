#!/bin/bash
# Gives the web version (port 443) a free Let's Encrypt certificate for a domain name, e.g.
#   bash domain.sh sepan.example.ir [email]
# Before: an A record of that name must point at this server (with Cloudflare: "DNS only", grey cloud),
# and ports 80/443 must be reachable. Let's Encrypt checks the name over port 80, where the Sepan server
# answers /.well-known/acme-challenge/ from /opt/messenger/data/acme. certbot renews it by itself; the
# Sepan server picks up the new files within a minute (no restart). Visitors by the IP and the Android app
# (port 8443) keep their own certificates.
# Remove again:  certbot delete --cert-name NAME; rm -rf /opt/messenger/certs/le/NAME
set -euo pipefail
NAME="${1:-}"
EMAIL="${2:-}"
if [ "$(id -u)" != "0" ]; then echo "Run as root"; exit 1; fi
if ! [[ "$NAME" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]]; then echo "Usage: bash domain.sh NAME [email]"; exit 1; fi
NAME=$(echo "$NAME" | tr 'A-Z' 'a-z')

MYIP=$(grep -o 'PUBLIC_HOST=[^ ]*' /etc/systemd/system/messenger.service 2>/dev/null | cut -d= -f2 || true)
DNSIP=$(getent ahostsv4 "$NAME" | awk 'NR==1{print $1}' || true)
echo "Domain $NAME -> ${DNSIP:-?}   (this server: ${MYIP:-?})"
if [ -z "$DNSIP" ]; then echo "The name does not resolve yet. Add the A record and try again in a few minutes."; exit 1; fi
if [ -n "$MYIP" ] && [ "$DNSIP" != "$MYIP" ]; then
  echo "WARNING: $NAME points at $DNSIP, not at $MYIP. With Cloudflare, switch the record to 'DNS only' (grey cloud)."
fi

command -v certbot >/dev/null 2>&1 || { apt-get update -y >/dev/null; DEBIAN_FRONTEND=noninteractive apt-get install -y certbot >/dev/null; }

WEBROOT=/opt/messenger/data/acme
mkdir -p $WEBROOT/.well-known/acme-challenge
chown -R msg:msg $WEBROOT; chmod -R a+rX $WEBROOT

# copies the certificate where the Sepan server reads it, now and after every renewal
HOOK=/etc/letsencrypt/renewal-hooks/deploy/sepan-web.sh
mkdir -p "$(dirname $HOOK)"
cat > $HOOK <<'HOOKEOF'
#!/bin/bash
# installed by Sepan domain.sh: copy a renewed certificate to /opt/messenger/certs/le/<name>/
set -e
N=$(basename "$RENEWED_LINEAGE")
D=/opt/messenger/certs/le/$N
mkdir -p "$D"
cp "$RENEWED_LINEAGE/fullchain.pem" "$D/cert.pem.new"; cp "$RENEWED_LINEAGE/privkey.pem" "$D/key.pem"
mv "$D/cert.pem.new" "$D/cert.pem"
chown -R msg:msg /opt/messenger/certs/le; chmod 755 /opt/messenger/certs/le "$D"; chmod 600 "$D/key.pem"
HOOKEOF
chmod 755 $HOOK

if [ -n "$EMAIL" ]; then MAIL=(--email "$EMAIL"); else MAIL=(--register-unsafely-without-email); fi
umask 022
certbot certonly --webroot -w $WEBROOT -d "$NAME" --non-interactive --agree-tos "${MAIL[@]}" --keep-until-expiring --deploy-hook $HOOK

# certbot skips the deploy hook when the certificate was already there: copy once more anyway
RENEWED_LINEAGE=/etc/letsencrypt/live/$NAME bash $HOOK
echo "Checking https://$NAME/ (the server looks at new certificates once a minute) ..."
OK=0
for i in $(seq 1 14); do
  if curl -fsS -o /dev/null --max-time 10 "https://$NAME/"; then OK=1; break; fi
  sleep 5
done
if [ $OK = 1 ]; then echo "OK: https://$NAME/ has a valid certificate"; else echo "Not confirmed from the server itself; open https://$NAME/ in a browser"; fi
systemctl list-timers 2>/dev/null | grep -q certbot && echo "Automatic renewal: certbot.timer is active"
