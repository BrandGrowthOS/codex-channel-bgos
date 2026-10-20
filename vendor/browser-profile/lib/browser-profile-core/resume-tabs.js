"use strict";
// Main/daemon only. These are encrypted navigation hints, never a live page,
// browser history, permission grant or instruction to navigate before activation.
const MAX_TABS = 64, MAX_URL = 8192, MAX_TITLE = 512;
const fail = () => Object.assign(new Error("profile_resume_tabs_refused"), { code: "profile_resume_tabs_refused" });
const authPath = /(?:^|\/)(?:login|log-in|signin|sign-in|signout|sign-out|logout|auth|oauth|oauth2|authorize|authorization|callback|auth[-_]?callback|oauth2?callback|signin[-_]?callback|sso|saml|acs|challenge|consent|password|device)(?:\.(?:html?|php[0-9]?|aspx?|jsp))?(?:\/|$)/i;
const secretKeys = new Set(["code", "state", "access_token", "id_token", "refresh_token", "token", "session_token", "client_secret", "client_id", "response_type", "code_challenge", "code_verifier", "redirect_uri", "assertion", "samlresponse", "samlrequest", "sig", "signature", "ticket"]);
function exact(value, fields) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], "value"))) throw fail();
  return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
}
function classifyResumeURL(value) {
  if (typeof value !== "string" || value.length > MAX_URL || /[\u0000-\u0020\u007f\\]/.test(value)) throw fail();
  if (value === "about:blank") return "automatic";
  let url; try { url = new URL(value); } catch { throw fail(); }
  if (url.href !== value || url.username || url.password || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw fail();
  let path; try { path = decodeURIComponent(url.pathname); } catch { throw fail(); }
  if (authPath.test(path) || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) throw fail();
  const inspect = query => {
    let count = 0;
    for (const [key] of new URLSearchParams(query)) if (++count > 100 || secretKeys.has(key.toLowerCase().replace(/-/g, "_"))) throw fail();
  };
  inspect(url.search);
  // Hash routers may prefix a query with a route. Inspect both without
  // rewriting the encrypted URL or treating a routed callback as resumable.
  const fragment = url.hash.slice(1), question = fragment.indexOf("?");
  let fragmentPath; try { fragmentPath = decodeURIComponent(question < 0 ? fragment : fragment.slice(0, question)); } catch { throw fail(); }
  if (authPath.test(fragmentPath) || /[\u0000-\u001f\u007f\\]/.test(fragmentPath)) throw fail();
  inspect(fragment); if (question >= 0) inspect(fragment.slice(question + 1));
  // Unknown query/fragment semantics require local human review. Keep the
  // original exact URL. Silently stripping them can replay a different action.
  return url.search || url.hash ? "review" : "automatic";
}
function validateResumeTabs(raw) {
  const value = exact(raw, ["version", "selectedIndex", "tabs"]), tabs = value.tabs;
  if (value.version !== 1 || !Array.isArray(tabs) || Object.getPrototypeOf(tabs) !== Array.prototype || tabs.length > MAX_TABS || Reflect.ownKeys(tabs).length !== tabs.length + 1 ||
      !Number.isSafeInteger(value.selectedIndex) || (tabs.length ? value.selectedIndex < 0 || value.selectedIndex >= tabs.length : value.selectedIndex !== -1)) throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(tabs), result = [];
  for (let index = 0; index < tabs.length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw fail();
    const row = exact(descriptor.value, ["url", "title"]); classifyResumeURL(row.url);
    if (typeof row.title !== "string" || row.title.length > MAX_TITLE || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(row.title)) throw fail();
    result.push(Object.freeze({ url: row.url, title: row.title }));
  }
  return Object.freeze({ version: 1, selectedIndex: value.selectedIndex, tabs: Object.freeze(result) });
}
module.exports = { MAX_TABS, MAX_URL, MAX_TITLE, classifyResumeURL, validateResumeTabs };
