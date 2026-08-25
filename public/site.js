const toggle = document.querySelector("[data-menu-toggle]");
const navigation = document.querySelector("[data-site-nav]");

toggle?.addEventListener("click", () => {
  const open = navigation?.classList.toggle("open") || false;
  toggle.setAttribute("aria-expanded", String(open));
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

const offerForm = document.querySelector("[data-offer-form]");
const offerStatus = document.querySelector("[data-offer-status]");
offerForm?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!offerForm.reportValidity()) return;
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
