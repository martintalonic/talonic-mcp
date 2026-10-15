import { afterEach, describe, expect, it, vi } from "vitest"
import {
  handleClaimTask,
  handleEvaluate,
  handleFrameworks,
  handleIssues,
  handleListTasks,
  handleRules,
  handleSetDecider,
  handleStatus,
  handleSubmitTask,
  handleTaskEpoch,
  probeComplianceAccess,
} from "../../src/tools/compliance"
import { createServer } from "../../src/server-factory"
import { complianceAccessCached } from "../../src/http-server"

const TASK = "11111111-1111-4111-8111-111111111111"
const FRAMEWORK = "22222222-2222-4222-8222-222222222222"
const DOC = "33333333-3333-4333-8333-333333333333"
const API = "https://api.talonic.com/v1/compliance"
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

const text = (r: { content: Array<{ text?: string }> }) => JSON.parse(r.content[0]!.text!)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("compliance reads", () => {
  it("status joins the decider, the open tasks and the evaluation counts", async () => {
    const call = stub(
      { decider: "external" },
      { data: [{ id: TASK }, { id: "x" }] },
      { processing: 0, waiting: 2 },
    )
    const res = await handleStatus(token, undefined)
    expect(text(res)).toEqual({
      decider: "external",
      open_tasks: 2,
      evaluations: { processing: 0, waiting: 2 },
    })
    expect([call(0).url, call(1).url, call(2).url]).toEqual([
      `${API}/settings`,
      `${API}/tasks`,
      `${API}/evaluations/status`,
    ])
    expect(call(0).auth).toBe("Bearer tlnc_key")
  })

  it("frameworks, rules and issues hit their routes", async () => {
    let call = stub({ data: [] })
    await handleFrameworks(token, undefined)
    expect(call().url).toBe(`${API}/frameworks`)
    call = stub([])
    await handleRules(token, undefined, { framework_id: FRAMEWORK })
    expect(call().url).toBe(`${API}/frameworks/${FRAMEWORK}/rules`)
    call = stub({ data: [] })
    await handleIssues(token, undefined, {})
    expect(call().url).toBe(`${API}/issues?unclear=true`)
    call = stub({ data: [] })
    await handleIssues(token, undefined, { unclear: false })
    expect(call().url).toBe(`${API}/issues`)
  })
})

describe("compliance writes", () => {
  it("evaluate posts the documents", async () => {
    const call = stub([{ id: "e", status: "waiting" }])
    await handleEvaluate(token, undefined, { document_ids: [DOC] })
    expect(call()).toMatchObject({
      url: `${API}/evaluations`,
      method: "POST",
      body: { document_ids: [DOC] },
    })
  })

  it("set_decider puts the setting", async () => {
    const call = stub({ decider: "external", cancelled: 0 })
    await handleSetDecider(token, undefined, { decider: "external" })
    expect(call()).toMatchObject({
      url: `${API}/settings`,
      method: "PUT",
      body: { decider: "external" },
    })
  })
})

describe("compliance tasks", () => {
  it("lists open tasks by default and all on request", async () => {
    let call = stub({ data: [] })
    await handleListTasks(token, undefined, {})
    expect(call().url).toBe(`${API}/tasks`)
    call = stub({ data: [] })
    await handleListTasks(token, undefined, { status: "all" })
    expect(call().url).toBe(`${API}/tasks?status=all`)
  })

  it("claims, submits, renews and releases with the epoch", async () => {
    let call = stub({
      task: { id: TASK, execution_epoch: 3 },
      instructions: "i",
      input: "x",
      output_schema: {},
    })
    const claimed = text(await handleClaimTask(token, undefined, { task_id: TASK }))
    expect(claimed.task.execution_epoch).toBe(3)
    expect(call()).toMatchObject({ url: `${API}/tasks/${TASK}/claim`, method: "POST" })

    call = stub({ task: { status: "submitted" } })
    await handleSubmitTask(token, undefined, {
      task_id: TASK,
      execution_epoch: 3,
      answer: { verdicts: [] },
    })
    expect(call()).toMatchObject({
      url: `${API}/tasks/${TASK}/submit`,
      body: { execution_epoch: 3, answer: { verdicts: [] } },
    })

    call = stub({ status: "claimed" })
    await handleTaskEpoch(token, undefined, "heartbeat", { task_id: TASK, execution_epoch: 3 })
    expect(call()).toMatchObject({
      url: `${API}/tasks/${TASK}/heartbeat`,
      body: { execution_epoch: 3 },
    })

    call = stub({ status: "available" })
    await handleTaskEpoch(token, undefined, "release", { task_id: TASK, execution_epoch: 3 })
    expect(call()).toMatchObject({
      url: `${API}/tasks/${TASK}/release`,
      body: { execution_epoch: 3 },
    })
  })

  it("passes a refused answer back as a tool error naming the problems", async () => {
    stub(jsonResponse({ message: "The answer was not stored: rules not answered: 2" }, 422))
    const res = await handleSubmitTask(token, undefined, {
      task_id: TASK,
      execution_epoch: 1,
      answer: { verdicts: [] },
    })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain("rules not answered: 2")
  })
})

describe("compliance registration", () => {
  const names = (opts: Record<string, unknown>) =>
    Object.keys((createServer({ apiKey: "tlnc_test", ...opts }) as any)._registeredTools).filter(
      (n) => n.startsWith("talonic_compliance_"),
    )

  it("lists the eleven tools only when the probe passed", () => {
    expect(names({})).toEqual([])
    expect(names({ includeComplianceTools: true })).toHaveLength(11)
  })

  it("annotates reads read-only, and the switch and submit destructive", () => {
    const tools = (createServer({ apiKey: "tlnc_test", includeComplianceTools: true }) as any)
      ._registeredTools
    for (const n of ["status", "frameworks", "rules", "issues", "list_tasks"]) {
      expect(tools[`talonic_compliance_${n}`].annotations).toMatchObject({ readOnlyHint: true })
    }
    for (const n of ["set_decider", "submit_task"]) {
      expect(tools[`talonic_compliance_${n}`].annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      })
    }
    for (const n of ["evaluate", "claim_task", "heartbeat_task", "release_task"]) {
      expect(tools[`talonic_compliance_${n}`].annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      })
    }
  })

  it("descriptions carry USE WHEN, NOT FOR, ARGS and RETURNS", () => {
    const tools = (createServer({ apiKey: "tlnc_test", includeComplianceTools: true }) as any)
      ._registeredTools
    for (const n of names({ includeComplianceTools: true })) {
      const d: string = tools[n].description
      for (const part of ["USE WHEN:", "NOT FOR:", "ARGS:", "RETURNS:"]) expect(d).toContain(part)
    }
  })
})

describe("compliance probe", () => {
  it("passes on 200 and fails on an error or a 404", async () => {
    let call = stub({ decider: "platform" })
    expect(await probeComplianceAccess("tlnc_key")).toBe(true)
    expect(call().url).toBe(`${API}/settings`)
    stub(jsonResponse({}, 404))
    expect(await probeComplianceAccess("tlnc_key")).toBe(false)
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")))
    expect(await probeComplianceAccess("tlnc_key")).toBe(false)
  })

  it("caches the probe per token", async () => {
    const probe = vi.fn().mockResolvedValue(true)
    let t = 0
    const now = () => t
    expect(await complianceAccessCached("tok-compliance", probe, now)).toBe(true)
    expect(await complianceAccessCached("tok-compliance", probe, now)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
