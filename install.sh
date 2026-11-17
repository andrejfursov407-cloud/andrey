#!/usr/bin/env bash
# Всё на одном сервере (Ubuntu 24.04): сайт + HTTPS + сигнализация + TURN.
#   С доменом: sudo ./install.sh messenger.example.com [email]   (сертификат Let's Encrypt)
#   Только IP: sudo ./install.sh [IP]                             (свой сертификат; IP определится сам)
set -euo pipefail
[ "$EUID" -eq 0 ] || { echo "Запустите через sudo"; exit 1; }
ARG="${1:-}"; EMAIL="${2:-}"; DIR=/opt/andrey; SECRET=$(openssl rand -hex 24 2>/dev/null || true)
apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm certbot coturn rsync openssl curl
SECRET=$(openssl rand -hex 24)
if [[ "$ARG" =~ [A-Za-z] ]]; then MODE=domain; HOSTN="$ARG"
else MODE=ip; HOSTN="${ARG:-$(curl -4s --max-time 8 https://api.ipify.org || hostname -I | awk '{print $1}')}"; fi
echo "Режим: $MODE, адрес: $HOSTN"
id andrey &>/dev/null || useradd --system --home "$DIR" --shell /usr/sbin/nologin andrey
mkdir -p "$DIR"; rsync -a --exclude node_modules --exclude data --exclude .git ./ "$DIR"/
mkdir -p "$DIR/data/certs"; (cd "$DIR" && npm install --omit=dev)
if [ "$MODE" = ip ]; then
  cd "$DIR/data/certs"
  [ -f ca.key ] || openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -keyout ca.key -out ca.crt -subj "/CN=Andrey Messenger CA"
  openssl req -newkey rsa:2048 -nodes -keyout privkey.pem -out s.csr -subj "/CN=$HOSTN"
  printf "subjectAltName=IP:$HOSTN\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n" > ext
  openssl x509 -req -in s.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 800 -sha256 -extfile ext -out fullchain.pem
  rm -f s.csr ext ca.srl; cp ca.crt "$DIR/public/ca.crt"; chmod 600 ca.key privkey.pem; cd - >/dev/null
fi
chown -R andrey:andrey "$DIR"; chmod 700 "$DIR/data"
cat > /etc/turnserver.conf <<T
listening-port=3478
realm=$HOSTN
use-auth-secret
static-auth-secret=$SECRET
fingerprint
no-cli
no-multicast-peers
min-port=49160
max-port=49200
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
T
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
cat > /etc/systemd/system/andrey.service <<U
[Unit]
Description=Andrey messenger
After=network.target
[Service]
User=andrey
WorkingDirectory=$DIR
Environment=PORT=443 HTTP_PORT=80 TURN_SECRET=$SECRET
ExecStart=/usr/bin/node server.js
Restart=always
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DIR/data
[Install]
WantedBy=multi-user.target
U
chmod 600 /etc/systemd/system/andrey.service
command -v ufw >/dev/null && ufw status | grep -q active && { ufw allow 80,443,3478/tcp; ufw allow 3478/udp; ufw allow 49160:49200/udp; } || true
systemctl daemon-reload; systemctl enable coturn; systemctl restart coturn; systemctl enable andrey; systemctl restart andrey
if [ "$MODE" = domain ]; then
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/andrey.sh <<H
#!/bin/sh
cp "\$RENEWED_LINEAGE/fullchain.pem" "\$RENEWED_LINEAGE/privkey.pem" $DIR/data/certs/
chown andrey:andrey $DIR/data/certs/*; chmod 600 $DIR/data/certs/privkey.pem
systemctl restart andrey
H
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/andrey.sh; sleep 2
  certbot certonly --webroot -w "$DIR/public" -d "$HOSTN" ${EMAIL:+-m "$EMAIL"} ${EMAIL:---register-unsafely-without-email} --agree-tos -n
  RENEWED_LINEAGE=/etc/letsencrypt/live/$HOSTN /etc/letsencrypt/renewal-hooks/deploy/andrey.sh
  echo "Готово: https://$HOSTN"
else
  echo "Готово: https://$HOSTN"
  echo "Сертификат свой, поэтому на каждом устройстве один раз: откройте http://$HOSTN/ca.crt и установите его (см. README)."
fi
