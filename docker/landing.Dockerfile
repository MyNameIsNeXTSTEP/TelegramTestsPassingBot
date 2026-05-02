FROM nginx:1.27-alpine

RUN apk add --no-cache gettext

COPY landing-site /usr/share/nginx/html

ARG LANDING_BRAND_NAME="Bashlarova Tests"
ARG LANDING_DOMAIN="bashlarovatests.ru"
ARG LANDING_BOT_URL="https://t.me/bashlarovatests_bot"
ARG LANDING_CONTACT_EMAIL="support@bashlarovatests.ru"
ARG LANDING_CONTACT_TELEGRAM="@bashlarova_support"
ARG LANDING_CONTACT_PHONE="+7 (900) 000-00-00"
ARG LANDING_SELLER_NAME="ИП Фамилия Имя Отчество"
ARG LANDING_SELLER_INN="000000000000"
ARG LANDING_SELLER_OGRNIP="000000000000000"
ARG LANDING_SELLER_CITY="г. Москва"

RUN export \
  LANDING_BRAND_NAME="${LANDING_BRAND_NAME}" \
  LANDING_DOMAIN="${LANDING_DOMAIN}" \
  LANDING_BOT_URL="${LANDING_BOT_URL}" \
  LANDING_CONTACT_EMAIL="${LANDING_CONTACT_EMAIL}" \
  LANDING_CONTACT_TELEGRAM="${LANDING_CONTACT_TELEGRAM}" \
  LANDING_CONTACT_PHONE="${LANDING_CONTACT_PHONE}" \
  LANDING_SELLER_NAME="${LANDING_SELLER_NAME}" \
  LANDING_SELLER_INN="${LANDING_SELLER_INN}" \
  LANDING_SELLER_OGRNIP="${LANDING_SELLER_OGRNIP}" \
  LANDING_SELLER_CITY="${LANDING_SELLER_CITY}" \
  && envsubst < /usr/share/nginx/html/config.js.template > /usr/share/nginx/html/config.js \
  && rm -f /usr/share/nginx/html/config.js.template \
  && apk del gettext

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
