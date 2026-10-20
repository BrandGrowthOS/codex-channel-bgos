const failure = () => Object.assign(new Error('The remote credential operation was refused or failed.'), { code: 'credential_storage' })

/** Ephemeral and bounded. Survives Not now so a page value cannot enter MCP. */
export class BrowserSecretRedactor {
  constructor() { this.secrets = new Set(); this.patterns = [] }
  register(secret) {
    if (typeof secret !== 'string' || !secret || secret.length > 4096 || (!this.secrets.has(secret) && this.secrets.size >= 1000)) throw failure()
    if (this.secrets.has(secret)) return
    this.secrets.add(secret)
    const json = JSON.stringify(secret).slice(1, -1)
    const variants = [secret, secret.replace(/[\r\n]/g, ''), json, JSON.stringify(json).slice(1, -1), secret.replaceAll("'", "''"), encodeURIComponent(secret), encodeURI(secret),
      secret.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')]
    const patterns = [...new Set([...this.patterns, ...variants])].filter(Boolean).sort((a, b) => b.length - a.length)
    // Pending synthesized results observe later fills. Close detaches this
    // array, leaving only those pending results holding its final patterns.
    this.patterns.splice(0, this.patterns.length, ...patterns)
  }
  text(value) { for (const pattern of this.patterns) value = value.replaceAll(pattern, '[REDACTED]'); return value }
  value(value) {
    if (typeof value === 'string') return this.text(value)
    if (Array.isArray(value)) return value.map(item => this.value(item))
    if (value && typeof value === 'object') {
      if (value.type === 'image' || value.type === 'audio') return value
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.value(item)]))
    }
    return value
  }
  clear() { this.secrets.clear(); this.patterns = [] }
}
