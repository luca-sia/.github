#!/usr/bin/env node
/**
 * Refreshes the "last 30 days" block of the profile README.
 *
 * Counts, for the last 30 days:
 *   - pull requests merged (GitHub search, split per day so the 1,000 result cap never bites)
 *   - lines changed in those pull requests (additions + deletions)
 *   - languages in the repositories pushed to in that window (by size)
 *   - AI tokens used, from our own metering service (optional, read-only token)
 *
 * Only totals are written. No repository names, titles or private details
 * ever reach the README. Client work is never counted: the search is limited
 * to the owners in STATS_QUERIES and the token total to the lanes in USAGE_LANES.
 *
 * Environment:
 *   GITHUB_TOKEN        token for the GitHub GraphQL API (required)
 *   STATS_QUERIES       search qualifiers, one per line, summed (required)
 *   LANGUAGE_OWNERS     comma separated owners whose active repos feed the languages row
 *   EXCLUDE_REPOS       comma separated owner/name repos never counted (client work)
 *   README_PATH         file to update (default README.md)
 *   USAGE_URL           metering endpoint that answers { buckets: [...] } per day (optional)
 *   USAGE_TOKEN         bearer for USAGE_URL (optional)
 *   USAGE_ACCESS_ID     Cloudflare Access service token id (optional)
 *   USAGE_ACCESS_SECRET Cloudflare Access service token secret (optional)
 *   USAGE_LANES         lanes to count (default none,lucasia)
 *
 * If a source fails, the last good number stays in place.
 */
import { readFile, writeFile } from 'node:fs/promises'

const DAYS = 30
const START = '<!--START_SECTION:stats-->'
const END = '<!--END_SECTION:stats-->'
const DATA = /<!--stats-data (\{.*?\}) -->/

const env = process.env
const readmePath = env.README_PATH || 'README.md'
const queries = (env.STATS_QUERIES || '').split('\n').map((q) => q.trim()).filter(Boolean)
const languageOwners = (env.LANGUAGE_OWNERS || '').split(',').map((o) => o.trim()).filter(Boolean)
const excluded = new Set((env.EXCLUDE_REPOS || '').split(',').map((r) => r.trim().toLowerCase()).filter(Boolean))
const lanes = new Set((env.USAGE_LANES || 'none,lucasia').split(',').map((l) => l.trim()))

const now = new Date()
const day = (d) => d.toISOString().slice(0, 10)
const since = new Date(now.getTime() - DAYS * 86_400_000)

async function graphql(query, variables) {
	for (let attempt = 1; ; attempt++) {
		const res = await fetch('https://api.github.com/graphql', {
			method: 'POST',
			headers: { authorization: `bearer ${env.GITHUB_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'profile-stats' },
			body: JSON.stringify({ query, variables }),
		})
		const body = await res.json().catch(() => ({}))
		if (res.ok && !body.errors) return body.data
		if (attempt >= 3) throw new Error(`GitHub ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`)
		await new Promise((r) => setTimeout(r, 2000 * attempt))
	}
}

const SEARCH = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { id additions deletions } }
  }
}`

/** Merged PRs and lines changed for every query, one day at a time. */
export async function pullRequestStats() {
	const seen = new Map()
	for (let i = 0; i <= DAYS; i++) {
		const d = day(new Date(since.getTime() + i * 86_400_000))
		if (d > day(now)) break
		for (const base of queries) {
			let after = null
			do {
				const minus = [...excluded].map((r) => `-repo:${r}`).join(' ')
				const data = await graphql(SEARCH, { q: `${base} ${minus} is:pr is:merged merged:${d}`, after })
				for (const n of data.search.nodes) if (n?.id) seen.set(n.id, (n.additions ?? 0) + (n.deletions ?? 0))
				after = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null
			} while (after)
		}
	}
	let lines = 0
	for (const v of seen.values()) lines += v
	return { prs: seen.size, lines }
}

const REPOS = `query($login: String!, $after: String) {
  repositoryOwner(login: $login) {
    repositories(first: 50, after: $after, isFork: false, orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner isArchived pushedAt languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } } }
    }
  }
}`

/** Top languages (share of bytes) across repos pushed to in the window. */
export async function languageStats() {
	const totals = new Map()
	for (const login of languageOwners) {
		let after = null
		outer: do {
			const data = await graphql(REPOS, { login, after })
			const page = data.repositoryOwner?.repositories
			if (!page) break
			for (const r of page.nodes) {
				if (new Date(r.pushedAt) < since) break outer
				if (r.isArchived || excluded.has(r.nameWithOwner.toLowerCase())) continue
				for (const e of r.languages.edges) totals.set(e.node.name, (totals.get(e.node.name) ?? 0) + e.size)
			}
			after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
		} while (after)
	}
	const sum = [...totals.values()].reduce((a, b) => a + b, 0)
	if (!sum) return []
	return [...totals.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 6)
		.map(([name, size]) => ({ name, pct: Math.round((size / sum) * 1000) / 10 }))
}

/** AI tokens used in the window, own lanes only. Null when the source is not set up. */
export async function tokenStats() {
	if (!env.USAGE_URL || !env.USAGE_TOKEN) return null
	const headers = { authorization: `Bearer ${env.USAGE_TOKEN}`, accept: 'application/json' }
	if (env.USAGE_ACCESS_ID && env.USAGE_ACCESS_SECRET) {
		headers['cf-access-client-id'] = env.USAGE_ACCESS_ID
		headers['cf-access-client-secret'] = env.USAGE_ACCESS_SECRET
	}
	const res = await fetch(env.USAGE_URL, { headers, redirect: 'manual' })
	if (!res.ok) throw new Error(`usage source answered ${res.status}`)
	const body = await res.json()
	return sumTokens(body, day(since))
}

export function sumTokens(body, fromDay) {
	let total = 0
	for (const b of body.buckets ?? []) {
		if (String(b.bucket) < fromDay) continue
		for (const c of b.clients ?? []) if (lanes.has(c.client)) total += c.all?.totalTokens ?? 0
	}
	return total
}

export function compact(n) {
	if (n === null || n === undefined) return 'n/a'
	const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']]
	for (const [v, s] of units) if (n >= v) return `${(n / v).toFixed(n / v >= 100 ? 0 : 1).replace(/\.0$/, '')}${s}`
	return n.toLocaleString('en-GB')
}

const badge = (label, value, color, style = 'for-the-badge') =>
	`<img alt="${label}: ${value}" src="https://img.shields.io/badge/${encodeURIComponent(label.replace(/-/g, '--').replace(/ /g, '_'))}-${encodeURIComponent(String(value).replace(/-/g, '--').replace(/ /g, '_'))}-${color}?style=${style}">`

export function render(s) {
	const langs = s.languages.length
		? s.languages.map((l) => badge(l.name, `${l.pct}%`, '30363d', 'flat-square')).join('\n  ')
		: '<em>No language data yet</em>'
	return [
		START,
		`<!--stats-data ${JSON.stringify(s)} -->`,
		'<p align="center">',
		`  ${badge('PRs merged', compact(s.prs), '0b5cad')}`,
		`  ${badge('Lines changed', compact(s.lines), '0b5cad')}`,
		...(s.tokens === null || s.tokens === undefined ? [] : [`  ${badge('AI tokens', compact(s.tokens), '0b5cad')}`]),
		'</p>',
		'<p align="center">',
		`  ${langs}`,
		'</p>',
		`<p align="center"><sub>Last 30 days, updated ${s.updated} (UK). Totals only, client work excluded.</sub></p>`,
		END,
	].join('\n')
}

async function main() {
	const readme = await readFile(readmePath, 'utf8')
	const a = readme.indexOf(START)
	const b = readme.indexOf(END)
	if (a < 0 || b < a) throw new Error(`${readmePath} has no stats section`)
	const prev = JSON.parse(readme.slice(a, b).match(DATA)?.[1] ?? '{}')

	const keep = async (name, fn, fallback) => {
		try {
			return await fn()
		} catch (e) {
			console.warn(`${name}: ${e.message}, keeping the last value`)
			return fallback
		}
	}
	// Without a token that can read the private repos the numbers would collapse, so keep the last ones.
	const github = Boolean(env.GITHUB_TOKEN)
	if (!github) console.warn('no GitHub token, keeping the last pull request and language numbers')
	const pr = !github ? { prs: prev.prs ?? null, lines: prev.lines ?? null } : await keep('pull requests', pullRequestStats, { prs: prev.prs ?? null, lines: prev.lines ?? null })
	// A token that cannot see the private repos reads as zero. Treat that as a failed read.
	if (github && pr.prs === 0 && prev.prs > 0) {
		console.warn('pull requests read as zero, keeping the last numbers')
		pr.prs = prev.prs
		pr.lines = prev.lines
	}
	let languages = !github ? (prev.languages ?? []) : await keep('languages', languageStats, prev.languages ?? [])
	if (!languages.length && prev.languages?.length) languages = prev.languages
	const tokens = (await keep('tokens', tokenStats, null)) ?? prev.tokens ?? null

	const updated = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' }).format(now)
	const stats = { prs: pr.prs, lines: pr.lines, tokens, languages, updated }
	const next = readme.slice(0, a) + render(stats) + readme.slice(b + END.length)
	if (next !== readme) await writeFile(readmePath, next)
	console.log(JSON.stringify(stats))
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((e) => {
		console.error(e)
		process.exit(1)
	})
}
