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
