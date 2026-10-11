const toggle = document.querySelector("[data-menu-toggle]");
const navigation = document.querySelector("[data-site-nav]");

const analyticsTargets = new Map([
  ["/connexion", "login"],
  ["/confidentialite", "legal_privacy"],
  ["/conditions-utilisation", "legal_terms"],
  ["/mentions-legales", "legal_notices"],
  ["/logiciel-entreprise-depannage", "solution_business"],
  ["/logiciel-planning-interventions", "solution_planning"],
  ["/logiciel-devis-factures-artisans", "solution_invoicing"],
  ["#demande-offre", "demo_request"],
  ["#tarifs", "pricing"],
  ["#solution", "features"],
  ["#securite", "security"],
  ["#questions-frequentes", "faq"]
]);

function recordPublicAnalytics(type, target = "") {
  if (navigator.doNotTrack === "1") return;
  fetch("/api/public/analytics/events", {
    method: "POST",
    credentials: "omit",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, page: window.location.pathname, target })
  }).catch(() => {});
}

recordPublicAnalytics("page_view");
document.addEventListener("click", event => {
  const link = event.target.closest("a[href]");
  if (!link) return;
  const href = link.getAttribute("href") || "";
  const target = href.startsWith("mailto:support@depannhomepro.com") ? "support_email" : analyticsTargets.get(href);
  if (target) recordPublicAnalytics("click", target);
});

toggle?.addEventListener("click", () => {
  const open = navigation?.classList.toggle("open") || false;
  toggle.setAttribute("aria-expanded", String(open));
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !navigation?.classList.contains("open")) return;
  navigation.classList.remove("open");
  toggle?.setAttribute("aria-expanded", "false");
  toggle?.focus();
});

document.addEventListener("click", event => {
  if (!navigation?.classList.contains("open") || navigation.contains(event.target) || toggle?.contains(event.target)) return;
  navigation.classList.remove("open");
  toggle?.setAttribute("aria-expanded", "false");
});

navigation?.addEventListener("click", event => {
  if (!event.target.closest("a")) return;
  navigation.classList.remove("open");
  toggle?.setAttribute("aria-expanded", "false");
});

document.querySelectorAll("[data-current-year]").forEach(node => {
  node.textContent = String(new Date().getFullYear());
});

const revealItems = document.querySelectorAll("[data-reveal]");
if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("revealed");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12 });
  revealItems.forEach(item => observer.observe(item));
} else {
  revealItems.forEach(item => item.classList.add("revealed"));
}

const backToTop = document.querySelector("[data-back-to-top]");
const updatePageChrome = () => {
  backToTop?.classList.toggle("visible", window.scrollY > 650);
  const sections = [...document.querySelectorAll("main section[id]")];
  const current = [...sections].reverse().find(section => section.getBoundingClientRect().top <= 130)?.id || "";
  navigation?.querySelectorAll('a[href^="#"]').forEach(link => {
    if (current && link.getAttribute("href") === `#${current}`) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
  });
};
updatePageChrome();
window.addEventListener("scroll", updatePageChrome, { passive: true });

const offerForm = document.querySelector("[data-offer-form]");
const offerStatus = document.querySelector("[data-offer-status]");
offerForm?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!offerForm.reportValidity()) return;
  recordPublicAnalytics("click", "offer_request");
  const submitButton = offerForm.querySelector("button[type='submit']");
  const data = new FormData(offerForm);
  const payload = Object.fromEntries(data.entries());
  payload.privacyConsent = data.get("privacyConsent") === "on";
  submitButton.disabled = true;
  offerStatus.className = "offer-form-status";
  offerStatus.textContent = "Envoi de votre demande…";
  try {
    const response = await fetch("/api/public/offer-requests", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || "Impossible d’envoyer votre demande.");
    offerForm.reset();
    offerStatus.classList.add("success");
    offerStatus.textContent = result.message;
  } catch (error) {
    offerStatus.classList.add("error");
    offerStatus.textContent = error.message || "Impossible d’envoyer votre demande.";
  } finally {
    submitButton.disabled = false;
  }
});
