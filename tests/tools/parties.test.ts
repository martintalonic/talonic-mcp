import { afterEach, describe, expect, it, vi } from "vitest"
import {
  PARTIES_POLL_INTERVAL_MS,
  handleConfirm,
  handleContract,
  handleContracts,
  handleGroupCompanies,
  handleIssues,
  handleMembers,
  handleMerge,
  handleParty,
  handleRead,
  handleSearch,
  handleSetRole,
  handleStatus,
  probePartiesAccess,
} from "../../src/tools/parties"
import { createServer } from "../../src/server-factory"
import { partiesAccessCached } from "../../src/http-server"

const CONTRACT = "11111111-1111-4111-8111-111111111111"
const PARTY = "22222222-2222-4222-8222-222222222222"
const OTHER = "33333333-3333-4333-8333-333333333333"
const ROLE = "44444444-4444-4444-8444-444444444444"
const MEMBER = "55555555-5555-4555-8555-555555555555"
const API = "https://api.talonic.com/v1/parties"
const token = () => "tlnc_key"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Stub fetch with one response per call (the last one repeats). */
function stub(...responses: Array<unknown | Response>) {
  const queue = responses.length ? responses : [{}]
  let i = 0
  const fetchMock = vi.fn().mockImplementation(async () => {
    const r = queue[Math.min(i++, queue.length - 1)]
    return r instanceof Response ? r.clone() : jsonResponse(r)
  })
  vi.stubGlobal("fetch", fetchMock)
  return (n = 0) => {
    const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit]
    return {
      url,
      method: init.method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init.headers).get("authorization"),
      count: fetchMock.mock.calls.length,
    }
  }
}

/** A clock the injected sleep advances. */
function clock() {
  let t = 0
  const sleeps: number[] = []
  return {
    sleeps,
    deps: {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        t += ms
      },
    },
  }
}

const parse = (res: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(res.content[0]!.text!)

afterEach(() => vi.unstubAllGlobals())

describe("parties reads", () => {
  it("status is a plain read with the bearer, against a custom base too", async () => {
    let call = stub({ contracts: 3 })
    await handleStatus(token, undefined)
    expect(call()).toMatchObject({ url: `${API}/status`, method: "GET", auth: "Bearer tlnc_key" })
    call = stub({ contracts: 3 })
    await handleStatus(token, "https://api.example.test")
    expect(call().url).toBe("https://api.example.test/v1/parties/status")
  })

  it("issues reads the worklist, filtered by code", async () => {
    let call = stub({ contracts: [], duplicates: [] })
    await handleIssues(token, undefined, {})
    expect(call()).toMatchObject({ method: "GET", url: `${API}/issues` })
    call = stub({ contracts: [], duplicates: [] })
    await handleIssues(token, undefined, { code: "possible_duplicate" })
    expect(call().url).toBe(`${API}/issues?code=possible_duplicate`)
  })

  it("contracts lists with q, state and limit", async () => {
    let call = stub({ total: 0, data: [] })
    await handleContracts(token, undefined, { query: "Müller", state: "suggested", limit: 50 })
    expect(call()).toMatchObject({
      method: "GET",
      url: `${API}/contracts?q=M%C3%BCller&state=suggested&limit=50`,
    })
    call = stub({ total: 0, data: [] })
    await handleContracts(token, undefined, {})
    expect(call().url).toBe(`${API}/contracts`)
  })

  it("contract reads one contract, on a day when given", async () => {
    let call = stub({ contract: { id: CONTRACT } })
    await handleContract(token, undefined, { contract_id: CONTRACT })
    expect(call()).toMatchObject({ method: "GET", url: `${API}/contracts/${CONTRACT}` })
    call = stub({ contract: { id: CONTRACT } })
    await handleContract(token, undefined, { contract_id: CONTRACT, on: "2026-01-31" })
    expect(call().url).toBe(`${API}/contracts/${CONTRACT}?on=2026-01-31`)
  })

  it("search lists the register with q, kind and limit", async () => {
    const call = stub({ total: 0, data: [] })
    await handleSearch(token, undefined, {
      query: "WEG Lindenweg",
      kind: "owners_association",
      limit: 10,
    })
    expect(call()).toMatchObject({
      method: "GET",
      url: `${API}?q=WEG+Lindenweg&kind=owners_association&limit=10`,
    })
  })
})

describe("parties party", () => {
  it("party_id alone reads the party", async () => {
    const call = stub({ party: { id: PARTY } })
    await handleParty(token, undefined, { party_id: PARTY })
    expect(call()).toMatchObject({ method: "GET", url: `${API}/${PARTY}` })
    expect(call().body).toBeUndefined()
  })

  it("party_id with fields patches only the given fields (null clears)", async () => {
    const call = stub({ id: PARTY })
    await handleParty(token, undefined, {
      party_id: PARTY,
      kind: "person",
      salutation: "frau",
      street: "Lindenweg 4",
      phone: null,
    })
    expect(call()).toMatchObject({
      method: "PATCH",
      url: `${API}/${PARTY}`,
      body: { kind: "person", salutation: "frau", street: "Lindenweg 4", phone: null },
    })
    expect(call().body).not.toHaveProperty("display_name")
  })

  it("without party_id creates with display_name and the fields", async () => {
    const call = stub({ id: PARTY })
    await handleParty(token, undefined, {
      display_name: "Musterfirma AG",
      postcode: "10115",
      external_refs: { debitor: "10042" },
    })
    expect(call()).toMatchObject({
      method: "POST",
      url: API,
      body: {
        display_name: "Musterfirma AG",
        postcode: "10115",
        external_refs: { debitor: "10042" },
      },
    })
  })

  it("without party_id and display_name fails before any call", async () => {
    const call = stub({})
    const res = await handleParty(token, undefined, { town: "Berlin" })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("Validation error")
    expect(() => call()).toThrow()
  })

  it("an edit of a merged party comes back as a tool error", async () => {
    stub(jsonResponse({ message: "This party was merged into another one; edit that one." }, 422))
    const res = await handleParty(token, undefined, { party_id: PARTY, town: "Berlin" })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("HTTP 422")
    expect(res.content[0]!.text).toContain("merged into another one")
  })
})

describe("parties roles", () => {
  it("contract_id + party_id + role adds a role", async () => {
    const call = stub({ id: ROLE })
    await handleSetRole(token, undefined, {
      contract_id: CONTRACT,
      party_id: PARTY,
      role: "tenant",
      enters_contract: true,
      valid_from: "2026-01-01",
      valid_to: "2026-12-31",
      note: "Mietvertrag S. 2",
    })
    expect(call()).toMatchObject({
      method: "POST",
      url: `${API}/contracts/${CONTRACT}/roles`,
      body: {
        party_id: PARTY,
        role: "tenant",
        enters_contract: true,
        valid_from: "2026-01-01",
        valid_to: "2026-12-31",
        note: "Mietvertrag S. 2",
      },
    })
    expect(call().body).not.toHaveProperty("contract_id")
  })

  it("adding needs party_id and role", async () => {
    const call = stub({})
    const res = await handleSetRole(token, undefined, { contract_id: CONTRACT, party_id: PARTY })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("needs party_id and role")
    expect(() => call()).toThrow()
  })

  it("role_id patches the row: reject, or clear a period with null", async () => {
    let call = stub({ id: ROLE, state: "rejected" })
    await handleSetRole(token, undefined, { role_id: ROLE, state: "rejected", note: "Altvertrag" })
    expect(call()).toMatchObject({
      method: "PATCH",
      url: `${API}/roles/${ROLE}`,
      body: { state: "rejected", note: "Altvertrag" },
    })
    call = stub({ id: ROLE })
    await handleSetRole(token, undefined, { role_id: ROLE, valid_to: null, represents_id: OTHER })
    expect(call().body).toEqual({ valid_to: null, represents_id: OTHER })
  })

  it("role_id with nothing to change, or both ids, fails before any call", async () => {
    const call = stub({})
    let res = await handleSetRole(token, undefined, { role_id: ROLE })
    expect(res.content[0]!.text).toContain("name something to change")
    res = await handleSetRole(token, undefined, {
      role_id: ROLE,
      contract_id: CONTRACT,
      state: "confirmed",
    })
    expect(res.isError).toBe(true)
    res = await handleSetRole(token, undefined, { state: "confirmed" })
    expect(res.isError).toBe(true)
    expect(() => call()).toThrow()
  })

  it("a role clash comes back as a tool error", async () => {
    stub(jsonResponse({ message: "The party already holds this role on the contract." }, 409))
    const res = await handleSetRole(token, undefined, { role_id: ROLE, role: "partner" })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("HTTP 409")
  })

  it("confirm defaults min_confidence to high and dry_run to false", async () => {
    let call = stub({ dry_run: false, confirmed: 0, rows: [] })
    await handleConfirm(token, undefined, {})
    expect(call()).toMatchObject({
      method: "POST",
      url: `${API}/roles/confirm`,
      body: { min_confidence: "high", dry_run: false },
    })
    call = stub({ dry_run: true, confirmed: 2, rows: [] })
    await handleConfirm(token, undefined, {
      contract_ids: [CONTRACT],
      roles: ["partner", "manager"],
      min_confidence: "medium",
      limit: 20,
      dry_run: true,
    })
    expect(call().body).toEqual({
      contract_ids: [CONTRACT],
      roles: ["partner", "manager"],
      min_confidence: "medium",
      limit: 20,
      dry_run: true,
    })
  })

  it("merge posts into and dry_run; a self-merge fails before any call", async () => {
    let call = stub({ dry_run: true, moves: 3, combined: 1 })
    await handleMerge(token, undefined, { party_id: PARTY, into: OTHER, dry_run: true })
    expect(call()).toMatchObject({
      method: "POST",
      url: `${API}/${PARTY}/merge`,
      body: { into: OTHER, dry_run: true },
    })
    call = stub({ dry_run: false })
    await handleMerge(token, undefined, { party_id: PARTY, into: OTHER })
    expect(call().body).toEqual({ into: OTHER, dry_run: false })
    call = stub({})
    const res = await handleMerge(token, undefined, { party_id: PARTY, into: PARTY })
    expect(res.isError).toBe(true)
    expect(() => call()).toThrow()
  })
})

describe("parties read queue", () => {
  it("queues with the options and returns at once without a wait", async () => {
    const call = stub({ dry_run: false, queued: 4, skipped: 0 })
    const res = await handleRead(token, undefined, {
      contract_ids: [CONTRACT],
      only_unread: false,
      force: true,
      limit: 10,
    })
    expect(call()).toMatchObject({
      method: "POST",
      url: `${API}/read`,
      body: {
        contract_ids: [CONTRACT],
        only_unread: false,
        force: true,
        limit: 10,
        dry_run: false,
      },
    })
    expect(call().count).toBe(1)
    expect(parse(res).queued).toBe(4)
  })

  it("a dry run is never waited for", async () => {
    const c = clock()
    const call = stub({ dry_run: true, would_queue: 120, skipped: 3, contracts: [] })
    const res = await handleRead(token, undefined, { dry_run: true, wait_seconds: 600 }, c.deps)
    expect(call().body).toEqual({ dry_run: true })
    expect(call().count).toBe(1)
    expect(c.sleeps).toEqual([])
    expect(parse(res).would_queue).toBe(120)
  })

  it("status: true only reads the queue", async () => {
    const call = stub({ contracts: 10, counts: { done: 10 }, unread: 0, failed: [] })
    const res = await handleRead(token, undefined, { status: true })
    expect(call()).toMatchObject({ method: "GET", url: `${API}/read/status` })
    expect(call().count).toBe(1)
    expect(parse(res).counts.done).toBe(10)
  })

  it("waits by polling the queue every 5 s until pending and running are 0", async () => {
    const c = clock()
    const call = stub(
      { dry_run: false, queued: 2, skipped: 0 },
      { counts: { pending: 2 } },
      { counts: { pending: 1, running: 1 } },
      { counts: { done: 2 }, unread: 0, failed: [] },
    )
    const res = await handleRead(token, undefined, { wait_seconds: 120 }, c.deps)
    expect(call(1)).toMatchObject({ method: "GET", url: `${API}/read/status` })
    expect(call().count).toBe(4)
    expect(c.sleeps).toEqual([PARTIES_POLL_INTERVAL_MS, PARTIES_POLL_INTERVAL_MS])
    expect(parse(res)).toMatchObject({
      queued: 2,
      status: { counts: { done: 2 } },
      still_running: false,
      waited_ms: 10_000,
    })
    expect(parse(res).next).toContain("talonic_parties_issues")
  })

  it("stops at the wait limit and says it is still running", async () => {
    const c = clock()
    stub({ queued: 1 }, { counts: { running: 1 } })
    const res = await handleRead(token, undefined, { wait_seconds: 7 }, c.deps)
    expect(c.sleeps).toEqual([5000, 2000])
    expect(parse(res)).toMatchObject({ still_running: true, waited_ms: 7000 })
  })

  it("status with a wait polls without queueing", async () => {
    const c = clock()
    const call = stub({ counts: { pending: 1 } }, { counts: { done: 1 } })
    const res = await handleRead(token, undefined, { status: true, wait_seconds: 30 }, c.deps)
    expect(call(0).method).toBe("GET")
    expect(call().count).toBe(2)
    expect(parse(res)).toMatchObject({ status: { counts: { done: 1 } }, still_running: false })
    expect(parse(res)).not.toHaveProperty("queued")
  })

  it("clamps a wait over 600 s", async () => {
    const c = clock()
    stub({ queued: 1 }, { counts: { running: 1 } })
    const res = await handleRead(token, undefined, { wait_seconds: 10_000 }, c.deps)
    expect(parse(res).waited_ms).toBe(600_000)
  })

  it("a poll failure ends the wait with the last state, not an error", async () => {
    const c = clock()
    stub({ queued: 1 }, { counts: { pending: 1 } }, jsonResponse({ message: "boom" }, 502))
    const res = await handleRead(token, undefined, { wait_seconds: 60 }, c.deps)
    expect(res.isError).toBeUndefined()
    expect(parse(res)).toMatchObject({
      queued: 1,
      still_running: true,
      status: { counts: { pending: 1 } },
    })
    expect(parse(res).poll_error).toContain("HTTP 502")
  })

  it("a refused queue comes back as a tool error", async () => {
    stub(jsonResponse({ message: "Contract not found" }, 404))
    const res = await handleRead(token, undefined, { contract_ids: [CONTRACT], wait_seconds: 30 })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("HTTP 404")
  })
})

describe("parties contacts and group companies", () => {
  it("members adds a contact with its function", async () => {
    const call = stub({ id: MEMBER })
    await handleMembers(token, undefined, {
      party_id: PARTY,
      person_id: OTHER,
      function: "Geschäftsführer",
    })
    expect(call()).toMatchObject({
      method: "POST",
      url: `${API}/${PARTY}/members`,
      body: { person_id: OTHER, function: "Geschäftsführer" },
    })
  })

  it("members removes a link with member_id alone", async () => {
    let call = stub({ ok: true })
    await handleMembers(token, undefined, { member_id: MEMBER })
    expect(call()).toMatchObject({ method: "DELETE", url: `${API}/members/${MEMBER}` })
    call = stub({})
    let res = await handleMembers(token, undefined, { member_id: MEMBER, party_id: PARTY })
    expect(res.isError).toBe(true)
    res = await handleMembers(token, undefined, { party_id: PARTY })
    expect(res.isError).toBe(true)
    expect(() => call()).toThrow()
  })

  it("members surfaces a refused contact as a tool error", async () => {
    stub(jsonResponse({ message: "A contact is a person." }, 422))
    const res = await handleMembers(token, undefined, { party_id: PARTY, person_id: OTHER })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("A contact is a person")
  })

  it("group_companies reads, or replaces with PUT", async () => {
    let call = stub({ data: [] })
    await handleGroupCompanies(token, undefined, {})
    expect(call()).toMatchObject({ method: "GET", url: `${API}/group-companies` })
    call = stub({ data: [] })
    const companies = [
      { name: "Musterfirma AG", relation: "parent" },
      { name: "Musterfirma Netz GmbH", parent: "Musterfirma AG", relation: "subsidiary" },
    ]
    await handleGroupCompanies(token, undefined, { companies })
    expect(call()).toMatchObject({
      method: "PUT",
      url: `${API}/group-companies`,
      body: { companies },
    })
  })
})

describe("parties tool registration", () => {
  const names = (opts: Record<string, unknown>) =>
    Object.keys((createServer({ apiKey: "tlnc_test", ...opts }) as any)._registeredTools).filter(
      (n) => n.startsWith("talonic_parties_"),
    )

  it("lists the twelve tools only when the probe passed", () => {
    expect(names({})).toEqual([])
    expect(names({ includePartiesTools: true })).toHaveLength(12)
  })

  it("annotates reads read-only and overwrites / merges / replacements destructive", () => {
    const tools = (createServer({ apiKey: "tlnc_test", includePartiesTools: true }) as any)
      ._registeredTools
    for (const n of ["status", "issues", "contracts", "contract", "search"]) {
      expect(tools[`talonic_parties_${n}`].annotations, n).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      })
    }
    for (const n of ["party", "set_role", "merge", "members", "group_companies"]) {
      expect(tools[`talonic_parties_${n}`].annotations.destructiveHint, n).toBe(true)
    }
    expect(tools.talonic_parties_party.annotations.idempotentHint).toBe(false)
    for (const n of ["confirm", "read"]) {
      expect(tools[`talonic_parties_${n}`].annotations, n).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      })
    }
    expect(tools.talonic_parties_merge.annotations.title).toBe("Merge duplicate parties")
  })

  it("descriptions follow the WHAT / USE WHEN / NOT FOR / ARGS / RETURNS format", () => {
    const tools = (createServer({ apiKey: "tlnc_test", includePartiesTools: true }) as any)
      ._registeredTools
    for (const n of names({ includePartiesTools: true })) {
      const d: string = tools[n].description
      for (const label of ["USE WHEN:", "NOT FOR:", "ARGS:", "RETURNS:"]) {
        expect(d, `${n} ${label}`).toContain(label)
      }
    }
    expect(tools.talonic_parties_set_role.description).toContain("Verwalter")
    expect(tools.talonic_parties_set_role.description).toContain("only do them when the user asked")
    expect(tools.talonic_parties_contract.description).toContain("computed by the platform")
  })

  it("the probe is true on 200 and false on 404 or a network error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ contracts: 0 }))
    vi.stubGlobal("fetch", fetchMock)
    expect(await probePartiesAccess("t")).toBe(true)
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${API}/status`)
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("authorization")).toBe("Bearer t")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)))
    expect(await probePartiesAccess("t")).toBe(false)
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")))
    expect(await probePartiesAccess("t")).toBe(false)
  })

  it("caches the probe per token", async () => {
    const probe = vi.fn().mockResolvedValue(true)
    const now = () => 1_000
    expect(await partiesAccessCached("tok-pt", probe, now)).toBe(true)
    expect(await partiesAccessCached("tok-pt", probe, now)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(await partiesAccessCached("tok-pt-2", probe, now)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
