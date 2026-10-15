import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { apiJson, buildUrl, runTool } from "./_http.js"
import type { ToolResult } from "./_shared.js"

/**
 * Compliance tools: frameworks (compliance and policy documents) become
 * checkable rules, and documents (or groups of documents that belong
 * together) are judged against the rules of the frameworks that are ON:
 * pass, fail, unclear or not applicable, with a reason and a quote.
 *
 * A workspace can let its own agent make those decisions instead of the
 * platform's model (decider `external`): reading a framework's requirements,
 * deriving its rules, every evaluation and every comparison of documents
 * then waits as a task. The agent claims a task, gets the same
 * instructions, input and answer schema the platform's model would get,
 * decides, and submits; the platform checks the answer (every rule answered
 * once, quotes found in the document) and stores it as its own.
 *
 * All tools hit `/v1/compliance/*` with the caller's bearer; the platform owns
 * every rule (scopes per route, the lease on each task).
 *
 * The task loop an agent runs: talonic_compliance_list_tasks →
 * talonic_compliance_claim_task → decide → talonic_compliance_submit_task
 * (talonic_compliance_heartbeat_task while it takes long,
 * talonic_compliance_release_task to hand a task back) → next task.
 */

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const
const write = (idempotent: boolean, destructive = false) =>
  ({
    readOnlyHint: false,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: false,
  }) as const

const taskIdArg = z.string().uuid().describe("Task id (from talonic_compliance_list_tasks).")
const epochArg = z
  .number()
  .int()
  .min(1)
  .describe("The execution_epoch talonic_compliance_claim_task returned (task.execution_epoch).")

const DECIDER_RULE =
  "Decider: `platform` (Talonic's model decides) or `external` (the workspace's own agent decides through these task tools; nothing is sent to Talonic's model)."

// ── Overview and reads ─────────────────────────────────────────────────────

const STATUS_DESCRIPTION = [
  "Compliance at a glance: who makes the decisions (decider), how many tasks wait for the workspace's own agent, and the latest evaluation of each listed single document and (under `groups`) of each document group: processing, waiting, completed, error, outdated, failing.",
  "USE WHEN: starting any compliance work, or to report where things stand. With decider `external`, continue with talonic_compliance_list_tasks.",
  "NOT FOR: the failed checks themselves (talonic_compliance_issues); the tasks (talonic_compliance_list_tasks).",
  "",
  "ARGS: none.",
  "RETURNS: { decider, open_tasks, evaluations { processing, waiting, completed, error, outdated, failing_documents, failing_rules (single documents), groups { processing, waiting, completed, error, outdated, failing, failing_rules } } }.",
].join("\n")

/** @internal */
export function handleStatus(
  getToken: () => string,
  baseUrl: string | undefined,
): Promise<ToolResult> {
  return runTool(async () => {
    const [settings, tasks, evaluations] = await Promise.all([
      apiJson<{ decider: string }>(getToken, baseUrl, "GET", "/v1/compliance/settings"),
      apiJson<{ data: unknown[] }>(getToken, baseUrl, "GET", "/v1/compliance/tasks"),
      apiJson(getToken, baseUrl, "GET", "/v1/compliance/evaluations/status"),
    ])
    return { decider: settings.decider, open_tasks: tasks.data.length, evaluations }
  })
}

const FRAMEWORKS_DESCRIPTION = [
  "The compliance frameworks of the workspace: each framework document with its extraction status, whether it is ON (only ON frameworks' rules are evaluated), its rule status (`waiting` = a rules task for the workspace's own agent) and how many rules it has.",
  "USE WHEN: checking which frameworks are in force, or finding a framework's id for talonic_compliance_rules.",
  "NOT FOR: the rules themselves (talonic_compliance_rules).",
  "",
  "ARGS: none.",
  "RETURNS: { data[] { document_id, status, active, framework_name, rules_status, rules_decided_by, generated_rule_count, summary } }.",
].join("\n")

/** @internal */
export function handleFrameworks(
  getToken: () => string,
  baseUrl: string | undefined,
): Promise<ToolResult> {
  return runTool(() => apiJson(getToken, baseUrl, "GET", "/v1/compliance/frameworks"))
}

const RULES_DESCRIPTION = [
  "The rules of one framework, in order: code, text, obligation (must, should, may), applies to, condition, threshold.",
  "USE WHEN: reading what a framework requires, or explaining a failed check.",
  "NOT FOR: the list of frameworks (talonic_compliance_frameworks).",
  "",
  "ARGS: `framework_id` (the framework's document_id).",
  "RETURNS: the rules array.",
].join("\n")

export const rulesInputSchema = {
  framework_id: z
    .string()
    .uuid()
    .describe("The framework's document_id (from talonic_compliance_frameworks)."),
}

/** @internal */
export function handleRules(
  getToken: () => string,
  baseUrl: string | undefined,
  args: { framework_id: string },
): Promise<ToolResult> {
  return runTool(() =>
    apiJson(
      getToken,
      baseUrl,
      "GET",
      `/v1/compliance/frameworks/${encodeURIComponent(args.framework_id)}/rules`,
    ),
  )
}

const ISSUES_DESCRIPTION = [
  "The compliance worklist: every rule a document group or a listed document failed in its latest evaluation (and, with unclear, the rules it could not confirm), with the framework, the reason and the quote; a group's check names the document its quote comes from.",
  "USE WHEN: reporting what is wrong, or deciding what to fix.",
  "NOT FOR: the headline counts (talonic_compliance_status).",
  "",
  "ARGS: `unclear` (default true: include unclear checks).",
  "RETURNS: { data[] { document_id | set_id, filename, document_count, outdated, results[] { framework_name, rule_code, rule_text, verdict, reason, quote, document_name } } }.",
].join("\n")

export const issuesInputSchema = {
  unclear: z.boolean().optional().describe("Include unclear checks (default true)."),
}

/** @internal */
export function handleIssues(
  getToken: () => string,
  baseUrl: string | undefined,
  args: { unclear?: boolean },
): Promise<ToolResult> {
  return runTool(() =>
    apiJson(getToken, baseUrl, "GET", "/v1/compliance/issues", {
      params: { unclear: args.unclear === false ? undefined : "true" },
    }),
  )
}

// ── Writes ─────────────────────────────────────────────────────────────────

const EVALUATE_DESCRIPTION = [
  "Evaluate documents against the rules of the frameworks that are ON. With decider `platform` Talonic's model judges them in the background; with decider `external` each evaluation waits as a task for the workspace's own agent (talonic_compliance_list_tasks).",
  "USE WHEN: the user asks to check documents for compliance. Only when the user asked.",
  "NOT FOR: reading results (talonic_compliance_issues).",
  "",
  "ARGS: `document_ids` (1 to 200 workspace document ids; frameworks are not evaluated).",
  "RETURNS: the evaluations started (status processing or waiting), one per document.",
].join("\n")

export const evaluateInputSchema = {
  document_ids: z
    .array(z.string().uuid())
    .min(1)
    .max(200)
    .describe("Workspace document ids to evaluate."),
}

/** @internal */
export function handleEvaluate(
  getToken: () => string,
  baseUrl: string | undefined,
  args: { document_ids: string[] },
): Promise<ToolResult> {
  return runTool(() =>
    apiJson(getToken, baseUrl, "POST", "/v1/compliance/evaluations", {
      body: { document_ids: args.document_ids },
    }),
  )
}

const SET_DECIDER_DESCRIPTION = [
  "Switch who makes the workspace's compliance decisions. " + DECIDER_RULE,
  "USE WHEN: the user asks to make the decisions with their own Claude, or to hand them back to Talonic. Only when the user asked: switching back to `platform` cancels every task still open.",
  "NOT FOR: reading the setting (talonic_compliance_status).",
  "",
  "ARGS: `decider` (platform | external).",
  "RETURNS: { decider, cancelled } (tasks cancelled by switching back).",
].join("\n")

export const setDeciderInputSchema = {
  decider: z.enum(["platform", "external"]).describe("Who decides from now on."),
}

/** @internal */
export function handleSetDecider(
  getToken: () => string,
  baseUrl: string | undefined,
  args: { decider: "platform" | "external" },
): Promise<ToolResult> {
  return runTool(() =>
    apiJson(getToken, baseUrl, "PUT", "/v1/compliance/settings", {
      body: { decider: args.decider },
    }),
  )
}

// ── Tasks for the workspace's own agent ────────────────────────────────────

const LIST_TASKS_DESCRIPTION = [
  "The compliance tasks waiting for the workspace's own agent (decider `external`): `extraction` (read a framework document and list its requirements verbatim), `rules` (derive checkable rules from those requirements), `evaluation` (judge a document or a group against rules) or `discrepancy` (compare a batch of documents). An expired claim reads available again. Work the oldest first: a framework's `rules` task appears only after its `extraction` task is answered.",
  "USE WHEN: working the compliance decisions yourself; claim the oldest with talonic_compliance_claim_task.",
  "NOT FOR: failed checks (talonic_compliance_issues).",
  "",
  "ARGS: `status` (open = available or claimed, the default; all = also submitted and cancelled).",
  "RETURNS: { data[] { id, kind, evaluation_id, framework_document_id, status, execution_epoch, claimed_by_label, lease_expires_at, created_at } }.",
].join("\n")

export const listTasksInputSchema = {
  status: z.enum(["open", "all"]).optional().describe("open (default) or all."),
}

/** @internal */
export function handleListTasks(
  getToken: () => string,
  baseUrl: string | undefined,
  args: { status?: "open" | "all" },
): Promise<ToolResult> {
  return runTool(() =>
    apiJson(getToken, baseUrl, "GET", "/v1/compliance/tasks", { params: { status: args.status } }),
  )
}

const CLAIM_TASK_DESCRIPTION = [
  "Claim a compliance task and get its work package: the instructions, the input (a framework's text; its extracted requirements; the document text(s) with the numbered rules; or the documents to compare) and the answer's JSON Schema, the same the platform's model would get. The claim lasts 15 minutes unless renewed.",
  "USE WHEN: about to decide a task from talonic_compliance_list_tasks. Follow `instructions` on `input`, then call talonic_compliance_submit_task with an `answer` matching `output_schema` and the returned execution_epoch.",
  "NOT FOR: listing tasks (talonic_compliance_list_tasks).",
  "",
  "ARGS: `task_id`.",
  'RETURNS: { task { id, kind, execution_epoch, lease_expires_at }, summary, instructions, input, output_schema, how_to_answer }. A task another agent holds answers 409 ("claimed by …"); claiming a task your own key or login already holds takes it over with a new epoch, and the older epoch can no longer submit, so do not run two sessions on the same task. A document still being read answers 409: claim it again in a minute.',
].join("\n")

export const claimTaskInputSchema = { task_id: taskIdArg }

/** @internal */
export function handleClaimTask(
  getToken: () => string,
  baseUrl: string | undefined,
  args: { task_id: string },
): Promise<ToolResult> {
  return runTool(() =>
    apiJson(
      getToken,
      baseUrl,
      "POST",
      `/v1/compliance/tasks/${encodeURIComponent(args.task_id)}/claim`,
    ),
  )
}

const SUBMIT_TASK_DESCRIPTION = [
  "Submit the answer to a claimed compliance task. The platform checks it as strictly as its own model's answer and stores it: an evaluation needs every rule number answered exactly once with a verdict (pass, fail, not_applicable, unclear) and a one-sentence reason, and every quote verbatim from the document (for a group, with its document number); a framework reading needs at least one rule whose text is verbatim in the document; rules need at least one rule with text, obligation and testable; a comparison needs a discrepancies array (empty when the documents agree) whose quotes are in the documents they name.",
  "USE WHEN: you decided a task you claimed. A refused answer names every problem; fix them and submit again with the same epoch.",
  "NOT FOR: giving a task back unanswered (talonic_compliance_release_task).",
  "",
  "ARGS: `task_id`; `execution_epoch` (from the claim); `answer` (an object matching the package's output_schema, e.g. { verdicts: [...] }, { framework_name, rules: [...] }, { rules: [...] } or { discrepancies: [...] }).",
  "RETURNS: { task { status: submitted }, result } (what was stored). Submitting the same answer again is harmless.",
].join("\n")

export const submitTaskInputSchema = {
  task_id: taskIdArg,
  execution_epoch: epochArg,
  answer: z
    .record(z.string(), z.unknown())
    .describe("The answer, matching the package's output_schema."),
}

/** @internal */
export function handleSubmitTask(
  getToken: () => string,
  baseUrl: string | undefined,
  args: { task_id: string; execution_epoch: number; answer: Record<string, unknown> },
): Promise<ToolResult> {
  return runTool(() =>
    apiJson(
      getToken,
      baseUrl,
      "POST",
      `/v1/compliance/tasks/${encodeURIComponent(args.task_id)}/submit`,
      {
        body: { execution_epoch: args.execution_epoch, answer: args.answer },
      },
    ),
  )
}

const HEARTBEAT_TASK_DESCRIPTION = [
  "Renew your claim on a compliance task for another 15 minutes.",
  "USE WHEN: a task takes long (a large group of documents) and the claim would run out before you submit.",
  "NOT FOR: submitting (talonic_compliance_submit_task).",
  "",
  "ARGS: `task_id`; `execution_epoch` (from the claim).",
  "RETURNS: the task with its new lease_expires_at.",
].join("\n")

const RELEASE_TASK_DESCRIPTION = [
  "Hand a claimed compliance task back unanswered, so another agent (or you, later) can take it.",
  "USE WHEN: you will not answer a task you claimed.",
  "NOT FOR: answering (talonic_compliance_submit_task).",
  "",
  "ARGS: `task_id`; `execution_epoch` (from the claim).",
  "RETURNS: the task, available again.",
].join("\n")

export const epochInputSchema = { task_id: taskIdArg, execution_epoch: epochArg }

/** @internal */
export function handleTaskEpoch(
  getToken: () => string,
  baseUrl: string | undefined,
  action: "heartbeat" | "release",
  args: { task_id: string; execution_epoch: number },
): Promise<ToolResult> {
  return runTool(() =>
    apiJson(
      getToken,
      baseUrl,
      "POST",
      `/v1/compliance/tasks/${encodeURIComponent(args.task_id)}/${action}`,
      {
        body: { execution_epoch: args.execution_epoch },
      },
    ),
  )
}

// ── Registration ───────────────────────────────────────────────────────────

/**
 * Whether the caller's deployment serves the Compliance app: one cheap
 * `/v1/compliance/settings` read. Never throws.
 *
 * @public
 */
export async function probeComplianceAccess(token: string, baseUrl?: string): Promise<boolean> {
  try {
    const res = await fetch(buildUrl(baseUrl, "/v1/compliance/settings"), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Register the eleven `talonic_compliance_*` tools.
 *
 * @public
 */
export function registerComplianceTools(
  server: McpServer,
  getToken: () => string,
  baseUrl?: string,
): void {
  const tools: Array<
    [
      string,
      string,
      string,
      Record<string, z.ZodTypeAny>,
      ReturnType<typeof write> | typeof readOnly,
      (args: any) => Promise<ToolResult>,
    ]
  > = [
    [
      "talonic_compliance_status",
      "Compliance status",
      STATUS_DESCRIPTION,
      {},
      readOnly,
      () => handleStatus(getToken, baseUrl),
    ],
    [
      "talonic_compliance_frameworks",
      "Compliance frameworks",
      FRAMEWORKS_DESCRIPTION,
      {},
      readOnly,
      () => handleFrameworks(getToken, baseUrl),
    ],
    [
      "talonic_compliance_rules",
      "Rules of a framework",
      RULES_DESCRIPTION,
      rulesInputSchema,
      readOnly,
      (a) => handleRules(getToken, baseUrl, a),
    ],
    [
      "talonic_compliance_issues",
      "Failed compliance checks",
      ISSUES_DESCRIPTION,
      issuesInputSchema,
      readOnly,
      (a) => handleIssues(getToken, baseUrl, a),
    ],
    [
      "talonic_compliance_evaluate",
      "Evaluate documents",
      EVALUATE_DESCRIPTION,
      evaluateInputSchema,
      write(false),
      (a) => handleEvaluate(getToken, baseUrl, a),
    ],
    [
      "talonic_compliance_set_decider",
      "Who makes compliance decisions",
      SET_DECIDER_DESCRIPTION,
      setDeciderInputSchema,
      // Switching back to the platform cancels the open tasks: destructive.
      write(true, true),
      (a) => handleSetDecider(getToken, baseUrl, a),
    ],
    [
      "talonic_compliance_list_tasks",
      "Compliance tasks",
      LIST_TASKS_DESCRIPTION,
      listTasksInputSchema,
      readOnly,
      (a) => handleListTasks(getToken, baseUrl, a),
    ],
    [
      "talonic_compliance_claim_task",
      "Claim a compliance task",
      CLAIM_TASK_DESCRIPTION,
      claimTaskInputSchema,
      write(false),
      (a) => handleClaimTask(getToken, baseUrl, a),
    ],
    [
      "talonic_compliance_submit_task",
      "Submit a compliance decision",
      SUBMIT_TASK_DESCRIPTION,
      submitTaskInputSchema,
      // Replaces the evaluation's results or the framework's rules: destructive.
      write(true, true),
      (a) => handleSubmitTask(getToken, baseUrl, a),
    ],
    [
      "talonic_compliance_heartbeat_task",
      "Renew a compliance task claim",
      HEARTBEAT_TASK_DESCRIPTION,
      epochInputSchema,
      write(true),
      (a) => handleTaskEpoch(getToken, baseUrl, "heartbeat", a),
    ],
    [
      "talonic_compliance_release_task",
      "Hand back a compliance task",
      RELEASE_TASK_DESCRIPTION,
      epochInputSchema,
      write(true),
      (a) => handleTaskEpoch(getToken, baseUrl, "release", a),
    ],
  ]
  for (const [name, title, description, inputSchema, annotations, handler] of tools) {
    server.registerTool(
      name,
      { title, description, inputSchema, annotations: { title, ...annotations } },
      async (args: unknown) => handler(args) as Promise<any>,
    )
  }
}
