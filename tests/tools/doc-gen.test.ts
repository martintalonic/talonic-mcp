import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DOC_GEN_POLL_INTERVAL_MS,
  handleConfirm,
  handleDelete,
  handleDraft,
  handleFile,
  handleGenerate,
  handleIssues,
  handleJobs,
  handleProducts,
  handleProfile,
  handlePropose,
  handleRetryPdf,
  handleRules,
  handleStatus,
  handleTemplates,
  handleUpdateTemplate,
  handleUpload,
  probeDocGenAccess,
} from "../../src/tools/doc-gen"
import { createServer } from "../../src/server-factory"
import { docGenAccessCached } from "../../src/http-server"

const TPL = "11111111-1111-4111-8111-111111111111"
const PROD = "22222222-2222-4222-8222-222222222222"
const JOB = "33333333-3333-4333-8333-333333333333"
const DOC = "44444444-4444-4444-8444-444444444444"
const API = "https://api.talonic.com/v1/doc-gen"
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

describe("doc-gen overview and templates", () => {
  it("status and issues are plain reads with the bearer", async () => {
    let call = stub({ templates: 3 })
    await handleStatus(token, undefined)
    expect(call()).toMatchObject({ url: `${API}/status`, method: "GET", auth: "Bearer tlnc_key" })
    call = stub({ data: [] })
    await handleIssues(token, "https://api.example.test")
    expect(call().url).toBe("https://api.example.test/v1/doc-gen/issues")
  })

  it("templates lists with q/group, or reads one template", async () => {
    let call = stub({ data: [] })
    await handleTemplates(token, undefined, { query: "Kündigung", group: "Strom" })
    expect(call().url).toBe(`${API}/templates?q=K%C3%BCndigung&group=Strom`)
    call = stub({ id: TPL, fields: [] })
    await handleTemplates(token, undefined, { template_id: TPL, query: "ignored" })
    expect(call().url).toBe(`${API}/templates/${TPL}`)
  })

  it("update_template patches metadata and fields by key, dry_run defaulting false", async () => {
    const call = stub({ dry_run: true })
    await handleUpdateTemplate(token, undefined, {
      template_id: TPL,
      group: null,
      fields: [{ key: "neuer_inhaber", source: { type: "case", caseKey: "owner" } }],
      dry_run: true,
    })
    expect(call()).toMatchObject({
      method: "PATCH",
      url: `${API}/templates/${TPL}`,
      body: {
        group: null,
        fields: [{ key: "neuer_inhaber", source: { type: "case", caseKey: "owner" } }],
        dry_run: true,
      },
    })
    expect(call().body).not.toHaveProperty("name")
  })

  it("update_template with nothing to change fails before any call", async () => {
    const call = stub({})
    const res = await handleUpdateTemplate(token, undefined, { template_id: TPL, dry_run: true })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("Validation error")
    expect(() => call()).toThrow()
  })

  it("confirm_fields posts keys, include_entered and dry_run", async () => {
    let call = stub({ confirmed: [] })
    await handleConfirm(token, undefined, { template_id: TPL, keys: ["a", "b"], dry_run: true })
    expect(call()).toMatchObject({
      method: "POST",
      url: `${API}/templates/${TPL}/confirm`,
      body: { keys: ["a", "b"], dry_run: true },
    })
    call = stub({ confirmed: [] })
    await handleConfirm(token, undefined, { template_id: TPL, include_entered: false })
    expect(call().body).toEqual({ include_entered: false, dry_run: false })
  })

  it("delete_template sends DELETE", async () => {
    const call = stub({ ok: true })
    await handleDelete(token, undefined, { template_id: TPL })
    expect(call()).toMatchObject({ method: "DELETE", url: `${API}/templates/${TPL}` })
  })
})

describe("doc-gen propose", () => {
  it("one template without a wait returns the start response", async () => {
    const call = stub({ proposal: { status: "running" }, template: { id: TPL } })
    const res = await handlePropose(token, undefined, {
      template_id: TPL,
      data_product_id: PROD,
      force: true,
    })
    expect(call()).toMatchObject({
      method: "POST",
      url: `${API}/templates/${TPL}/propose`,
      body: { data_product_id: PROD, force: true },
    })
    expect(call().count).toBe(1)
    expect(parse(res).proposal.status).toBe("running")
  })

  it("waits by polling the proposal every 3 s until it is no longer running", async () => {
    const c = clock()
    const call = stub(
      { proposal: { status: "running" }, template: { id: TPL } },
      { proposal: { status: "running" } },
      { proposal: { status: "done", summary: { fields: 12, proposed: 10 } } },
    )
    const res = await handlePropose(
      token,
      undefined,
      { template_id: TPL, data_product_id: PROD, wait_seconds: 60 },
      c.deps,
    )
    expect(call(1)).toMatchObject({ method: "GET", url: `${API}/templates/${TPL}/proposal` })
    expect(call().count).toBe(3)
    expect(c.sleeps).toEqual([DOC_GEN_POLL_INTERVAL_MS, DOC_GEN_POLL_INTERVAL_MS])
    const body = parse(res)
    expect(body).toMatchObject({
      template_id: TPL,
      proposal: { status: "done", summary: { fields: 12 } },
      still_running: false,
      waited_ms: 6000,
    })
  })

  it("stops at the wait limit and says it is still running", async () => {
    const c = clock()
    stub({ proposal: { status: "running" } })
    const res = await handlePropose(
      token,
      undefined,
      { template_id: TPL, data_product_id: PROD, wait_seconds: 5 },
      c.deps,
    )
    expect(c.sleeps).toEqual([3000, 2000])
    expect(parse(res)).toMatchObject({ still_running: true, waited_ms: 5000 })
  })

  it("a poll failure ends the wait with the last state, not an error", async () => {
    const c = clock()
    stub({ proposal: { status: "running" } }, jsonResponse({ message: "boom" }, 502))
    const res = await handlePropose(
      token,
      undefined,
      { template_id: TPL, data_product_id: PROD, wait_seconds: 30 },
      c.deps,
    )
    expect(res.isError).toBeUndefined()
    expect(parse(res)).toMatchObject({ still_running: true, proposal: { status: "running" } })
    expect(parse(res).poll_error).toContain("HTTP 502")
  })

  it("without template_id starts a bulk proposal", async () => {
    const call = stub({ dry_run: true, would_start: [] })
    await handlePropose(token, undefined, {
      data_product_id: PROD,
      template_ids: [TPL],
      only_unproposed: false,
      limit: 5,
      dry_run: true,
    })
    expect(call()).toMatchObject({
      method: "POST",
      url: `${API}/templates/propose`,
      body: {
        data_product_id: PROD,
        template_ids: [TPL],
        only_unproposed: false,
        force: false,
        limit: 5,
        dry_run: true,
      },
    })
  })
})

describe("doc-gen upload", () => {
  it("posts filename and base64 content with the metadata", async () => {
    const call = stub({ id: TPL })
    await handleUpload(token, undefined, {
      filename: "Brief.docx",
      content_base64: "UEsDBA==",
      group: "Strom",
      kind: "letter",
    })
    expect(call()).toMatchObject({
      method: "POST",
      url: `${API}/templates`,
      body: { filename: "Brief.docx", content_base64: "UEsDBA==", group: "Strom", kind: "letter" },
    })
  })

  it("reads file_path in a local install, naming the file after it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docgen-"))
    const file = path.join(dir, "Vorlage.dotx")
    writeFileSync(file, Buffer.from("hello"))
    const call = stub({ id: TPL })
    await handleUpload(token, undefined, { file_path: file }, { localFiles: true })
    expect(call().body).toEqual({
      filename: "Vorlage.dotx",
      content_base64: Buffer.from("hello").toString("base64"),
    })
  })

  it("refuses file_path on the hosted server, and needs a filename with content", async () => {
    const call = stub({})
    let res = await handleUpload(token, undefined, { file_path: "/etc/passwd" })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("local install")
    res = await handleUpload(token, undefined, { content_base64: "UEsDBA==" })
    expect(res.content[0]!.text).toContain("filename is required")
    res = await handleUpload(token, undefined, {})
    expect(res.isError).toBe(true)
    expect(() => call()).toThrow()
  })

  it("a missing local file is a tool error", async () => {
    stub({})
    const res = await handleUpload(
      token,
      undefined,
      { file_path: "/nonexistent/x.docx" },
      { localFiles: true },
    )
    expect(res.isError).toBe(true)
  })
})

describe("doc-gen data, rules and profile", () => {
  it("products lists, reads one, or lists rows with q and a default limit of 50", async () => {
    let call = stub({ data: [] })
    await handleProducts(token, undefined, {})
    expect(call().url).toBe(`${API}/products`)
    call = stub({ id: PROD })
    await handleProducts(token, undefined, { product_id: PROD })
    expect(call().url).toBe(`${API}/products/${PROD}`)
    call = stub({ total: 0, data: [] })
    await handleProducts(token, undefined, { product_id: PROD, records: true, query: "Muster" })
    expect(call().url).toBe(`${API}/products/${PROD}/records?q=Muster&limit=50`)
    call = stub({ total: 0, data: [] })
    await handleProducts(token, undefined, { product_id: PROD, records: true, limit: 500 })
    expect(call().url).toBe(`${API}/products/${PROD}/records?limit=500`)
  })

  it("records without a product is a validation error", async () => {
    stub({})
    const res = await handleProducts(token, undefined, { records: true })
    expect(res.content[0]!.text).toContain("records needs a product_id")
  })

  it("rules reads, or replaces with PUT", async () => {
    let call = stub({ data: [] })
    await handleRules(token, undefined, {})
    expect(call()).toMatchObject({ method: "GET", url: `${API}/rules` })
    call = stub({ data: [] })
    const rules = [{ name: "anrede", definition: { kind: "map" } }]
    await handleRules(token, undefined, { rules })
    expect(call()).toMatchObject({ method: "PUT", url: `${API}/rules`, body: { rules } })
  })

  it("profile reads; saving merges the given details into the saved ones", async () => {
    let call = stub({ name: "A. Muster", kuerzel: "AM", titel: "", bereich: "Vertrieb" })
    let res = await handleProfile(token, undefined, {})
    expect(call()).toMatchObject({ method: "GET", url: `${API}/profile` })
    expect(call().count).toBe(1)
    expect(parse(res).kuerzel).toBe("AM")

    call = stub({ name: "A. Muster", kuerzel: "AM", titel: "", bereich: "Vertrieb" }, { ok: 1 })
    res = await handleProfile(token, undefined, { titel: "Dr." })
    expect(call(1)).toMatchObject({
      method: "PUT",
      url: `${API}/profile`,
      body: { name: "A. Muster", kuerzel: "AM", titel: "Dr.", bereich: "Vertrieb" },
    })
  })
})

describe("doc-gen draft, generate, jobs, files", () => {
  const batch = {
    template_id: TPL,
    with_pair: true,
    data_product_id: PROD,
    record_ids: ["r1", "r2"],
    values: { neuer_inhaber: "Musterfirma AG" },
    documents: [{ record_id: "r2", values: { neuer_inhaber: "Beispiel GmbH" } }],
    profile: { name: "A. Muster" },
  }

  it("draft posts the batch body", async () => {
    const call = stub({ templates: [], documents: [] })
    await handleDraft(token, undefined, batch)
    expect(call()).toMatchObject({ method: "POST", url: `${API}/drafts`, body: batch })
  })

  it("draft and generate need a template", async () => {
    stub({})
    const { template_id: _t, ...noTemplate } = batch
    expect((await handleDraft(token, undefined, noTemplate)).isError).toBe(true)
    expect((await handleGenerate(token, undefined, noTemplate)).isError).toBe(true)
  })

  it("generate posts the batch with flags and returns at once without a wait", async () => {
    const call = stub({ dry_run: false, documents: [], job: { id: JOB, status: "running" } })
    const res = await handleGenerate(token, undefined, {
      ...batch,
      save_to_workspace: false,
      allow_missing: true,
    })
    expect(call()).toMatchObject({
      method: "POST",
      url: `${API}/jobs`,
      body: { ...batch, save_to_workspace: false, allow_missing: true, dry_run: false },
    })
    expect(call().count).toBe(1)
    expect(parse(res).job.status).toBe("running")
  })

  it("generate waits by polling the batch until it is no longer running", async () => {
    const c = clock()
    const call = stub(
      { dry_run: false, documents: [{ record_id: "r1" }], job: { id: JOB, status: "running" } },
      { id: JOB, status: "running" },
      { id: JOB, status: "completed", documents: [{ id: DOC }] },
    )
    const res = await handleGenerate(token, undefined, { ...batch, wait_seconds: 300 }, c.deps)
    expect(call(2)).toMatchObject({ method: "GET", url: `${API}/jobs/${JOB}` })
    expect(c.sleeps).toEqual([3000, 3000])
    expect(parse(res)).toMatchObject({
      documents: [{ record_id: "r1" }],
      job: { status: "completed" },
      still_running: false,
      waited_ms: 6000,
    })
  })

  it("generate does not poll a dry run (no job)", async () => {
    const c = clock()
    const call = stub({ dry_run: true, documents: [], job: null })
    await handleGenerate(token, undefined, { ...batch, dry_run: true, wait_seconds: 60 }, c.deps)
    expect(call().count).toBe(1)
    expect(c.sleeps).toEqual([])
  })

  it("an incomplete-batch refusal comes back as a tool error", async () => {
    stub(jsonResponse({ message: "2 of 2 document(s) leave fields empty (neuer_inhaber)" }, 422))
    const res = await handleGenerate(token, undefined, batch)
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("HTTP 422")
    expect(res.content[0]!.text).toContain("neuer_inhaber")
  })

  it("jobs lists with limit, or reads one; retry_pdf posts", async () => {
    let call = stub({ data: [] })
    await handleJobs(token, undefined, { limit: 5 })
    expect(call().url).toBe(`${API}/jobs?limit=5`)
    call = stub({ id: JOB })
    await handleJobs(token, undefined, { job_id: JOB })
    expect(call().url).toBe(`${API}/jobs/${JOB}`)
    call = stub({ id: JOB })
    await handleRetryPdf(token, undefined, { job_id: JOB })
    expect(call()).toMatchObject({ method: "POST", url: `${API}/jobs/${JOB}/pdf` })
  })

  it("file returns the bytes as an embedded resource with the API's filename", async () => {
    const bytes = Buffer.from("%PDF-1.7 test")
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${encodeURIComponent("Kündigung – Muster.pdf")}"`,
        },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const res = (await handleFile(token, undefined, {
      job_id: JOB,
      document_id: DOC,
      kind: "pdf",
    })) as any
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `${API}/jobs/${JOB}/documents/${DOC}/file?kind=pdf`,
    )
    expect(res.isError).toBeUndefined()
    expect(res.structuredContent).toEqual({
      filename: "Kündigung – Muster.pdf",
      mime_type: "application/pdf",
      size: bytes.length,
      kind: "pdf",
    })
    expect(res.content[1]).toMatchObject({
      type: "resource",
      resource: { mimeType: "application/pdf", blob: bytes.toString("base64") },
    })
  })

  it("file defaults to docx and refuses a file over the limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(Buffer.alloc(32), { status: 200, headers: { "content-type": "x/y" } }),
      )
    vi.stubGlobal("fetch", fetchMock)
    const res = await handleFile(token, undefined, { job_id: JOB, document_id: DOC }, 16)
    expect(String(fetchMock.mock.calls[0]![0])).toContain("kind=docx")
    expect(res.isError).toBe(true)
    expect(res.content[0]!.type === "text" && res.content[0]!.text).toContain("over the 16-byte")
  })

  it("file surfaces an API error (expired batch)", async () => {
    stub(jsonResponse({ message: "The files of this batch were not kept" }, 410))
    const res = await handleFile(token, undefined, { job_id: JOB, document_id: DOC })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.type === "text" && res.content[0]!.text).toContain("HTTP 410")
  })
})

describe("doc-gen tool registration", () => {
  const names = (opts: Record<string, unknown>) =>
    Object.keys((createServer({ apiKey: "tlnc_test", ...opts }) as any)._registeredTools).filter(
      (n) => n.startsWith("talonic_doc_gen_"),
    )

  it("lists the sixteen tools only when the probe passed", () => {
    expect(names({})).toEqual([])
    expect(names({ includeDocGenTools: true })).toHaveLength(16)
  })

  it("annotates reads read-only and deletion / replacement destructive", () => {
    const tools = (createServer({ apiKey: "tlnc_test", includeDocGenTools: true }) as any)
      ._registeredTools
    for (const n of ["status", "issues", "templates", "products", "draft", "jobs", "file"]) {
      expect(tools[`talonic_doc_gen_${n}`].annotations.readOnlyHint, n).toBe(true)
    }
    for (const n of ["delete_template", "rules", "update_template", "profile"]) {
      expect(tools[`talonic_doc_gen_${n}`].annotations.destructiveHint, n).toBe(true)
    }
    expect(tools.talonic_doc_gen_generate.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      title: "Generate documents",
    })
  })

  it("offers file_path for uploads only in a local (api-key) install", () => {
    const local = (createServer({ apiKey: "tlnc_test", includeDocGenTools: true }) as any)
      ._registeredTools.talonic_doc_gen_upload_template
    const hosted = (createServer({ tokenProvider: () => "t", includeDocGenTools: true }) as any)
      ._registeredTools.talonic_doc_gen_upload_template
    const shape = (t: any) => Object.keys(t.inputSchema.shape ?? t.inputSchema.def?.shape ?? {})
    expect(shape(local)).toContain("file_path")
    expect(shape(hosted)).not.toContain("file_path")
  })

  it("the probe is true on 200 and false on 404 or a network error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ templates: 0 }))
    vi.stubGlobal("fetch", fetchMock)
    expect(await probeDocGenAccess("t")).toBe(true)
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${API}/status`)
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("authorization")).toBe("Bearer t")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)))
    expect(await probeDocGenAccess("t")).toBe(false)
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")))
    expect(await probeDocGenAccess("t")).toBe(false)
  })

  it("caches the probe per token", async () => {
    const probe = vi.fn().mockResolvedValue(true)
    const now = () => 1_000
    expect(await docGenAccessCached("tok-dg", probe, now)).toBe(true)
    expect(await docGenAccessCached("tok-dg", probe, now)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
