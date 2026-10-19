import { en } from "./src/i18n/en.ts";
import { type LegalDocument, legalEn } from "./src/i18n/legal-en.ts";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function legalPage(page: "privacy" | "terms") {
  const document: LegalDocument = legalEn[page];
  const linkClass =
    "inline-flex min-h-11 items-center py-2 text-accent underline underline-offset-4 hover:text-text";
  const links = `
    <a class="${linkClass}" href="/privacy.html"${page === "privacy" ? ' aria-current="page"' : ""}>${escapeHtml(en.legal.privacy)}</a>
    <a class="${linkClass}" href="/terms.html"${page === "terms" ? ' aria-current="page"' : ""}>${escapeHtml(en.legal.terms)}</a>
    <a class="${linkClass}" href="/licensing.html">${escapeHtml(en.licensing.link)}</a>`;
  return {
    title: `${en.legal[page]} · ${en.app.title}`,
    description: document.description,
    body: `
      <div class="mx-auto w-[min(960px,calc(100%_-_2rem))] pb-8 font-ui md:w-[min(960px,calc(100%_-_3rem))]">
        <a class="fixed top-3 left-4 z-10 -translate-y-[200%] rounded-control bg-accent p-3 text-on-accent focus:translate-y-0" href="#main">${escapeHtml(en.app.skipLink)}</a>
        <header class="flex flex-wrap items-center justify-between gap-x-6 border-b border-divider py-4">
          <a class="block min-h-11 max-w-full py-2 font-display text-wordmark font-semibold tracking-[0.035em] uppercase [overflow-wrap:anywhere] max-sm:text-label" href="/">${escapeHtml(en.app.title)}</a>
          <a class="${linkClass}" href="/">${escapeHtml(legalEn.home)}</a>
        </header>
        <main id="main" tabindex="-1" class="mx-auto max-w-3xl py-8 md:py-12">
          <h1 class="font-display text-display font-medium max-sm:text-title">${escapeHtml(en.legal[page])}</h1>
          <p class="mt-4 text-label text-text-muted">${escapeHtml(legalEn.updated)}</p>
          <p class="mt-6 text-body leading-relaxed text-text-secondary">${escapeHtml(legalEn.introduction)}</p>
          <nav class="mt-8 rounded-panel border border-divider bg-surface p-4 md:p-6" aria-label="${escapeHtml(legalEn.contents)}">
            <p class="text-section font-semibold">${escapeHtml(legalEn.contents)}</p>
            <ul class="mt-3 grid gap-x-6 md:grid-cols-2">${document.sections.map((section) => `<li><a class="${linkClass}" href="#${section.id}">${escapeHtml(section.title)}</a></li>`).join("")}</ul>
          </nav>
          ${document.sections
            .map(
              (section) => `
            <section class="mt-10 scroll-mt-6" aria-labelledby="${section.id}">
              <h2 id="${section.id}" class="text-section font-semibold">${escapeHtml(section.title)}</h2>
              ${section.paragraphs.map((paragraph) => `<p class="mt-4 text-body leading-relaxed text-text-secondary">${escapeHtml(paragraph)}</p>`).join("")}
            </section>`,
            )
            .join("")}
          <aside class="mt-10 rounded-panel border border-divider bg-surface p-4 md:p-6">
            <p class="text-body">${escapeHtml(legalEn.contact)}</p>
            <a class="${linkClass} break-all" href="mailto:${escapeHtml(legalEn.email)}">${escapeHtml(legalEn.email)}</a>
          </aside>
        </main>
        <footer class="border-t border-divider pt-4">
          <nav class="flex flex-wrap justify-center gap-x-6 text-label" aria-label="${escapeHtml(en.legal.navigation)}">${links}</nav>
        </footer>
      </div>`,
  };
}
