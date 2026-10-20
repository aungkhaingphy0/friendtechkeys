// Applies the saved theme before first paint to avoid a flash. "system" = no attribute.
(function () {
  try {
    var t = localStorage.getItem("keys-sell:theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* storage unavailable */ }
})();
