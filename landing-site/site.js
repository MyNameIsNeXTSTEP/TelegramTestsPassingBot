function textOrFallback(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  return normalized || fallback;
}

const config = window.LANDING_CONFIG ?? {};
const botUrl = textOrFallback(config.botUrl, "https://t.me");
const brandName = textOrFallback(config.brandName, "Bashlarova Tests");
const domain = textOrFallback(config.domain, "bashlarovatests.ru");
const contactEmail = textOrFallback(config.contactEmail, "support@example.com");
const contactTelegram = textOrFallback(config.contactTelegram, "@support");
const contactPhone = textOrFallback(config.contactPhone, "+7 (900) 000-00-00");
const sellerName = textOrFallback(config.sellerName, "ИП Фамилия Имя Отчество");
const sellerInn = textOrFallback(config.sellerInn, "000000000000");
const sellerOgrnip = textOrFallback(config.sellerOgrnip, "000000000000000");
const sellerCity = textOrFallback(config.sellerCity, "г. Москва");

document.querySelectorAll("[data-bot-url]").forEach((node) => {
  node.setAttribute("href", botUrl);
});

document.querySelectorAll("[data-brand-name]").forEach((node) => {
  node.textContent = brandName;
});

document.querySelectorAll("[data-domain]").forEach((node) => {
  node.textContent = domain;
});

document.querySelectorAll("[data-contact-email]").forEach((node) => {
  node.textContent = contactEmail;
});

document.querySelectorAll("[data-contact-email-link]").forEach((node) => {
  node.setAttribute("href", `mailto:${contactEmail}`);
});

document.querySelectorAll("[data-contact-telegram]").forEach((node) => {
  node.textContent = contactTelegram;
});

document.querySelectorAll("[data-contact-phone]").forEach((node) => {
  node.textContent = contactPhone;
});

document.querySelectorAll("[data-seller-name]").forEach((node) => {
  node.textContent = sellerName;
});

document.querySelectorAll("[data-seller-inn]").forEach((node) => {
  node.textContent = sellerInn;
});

document.querySelectorAll("[data-seller-ogrnip]").forEach((node) => {
  node.textContent = sellerOgrnip;
});

document.querySelectorAll("[data-seller-city]").forEach((node) => {
  node.textContent = sellerCity;
});
