# Desktop migration contract

SolidJS + Tauri 2 + Rust. Production has no HTTP listener, Node sidecar, login,
registration, accounts, or remote user storage. First run sets a local nickname.
The existing web source and databases remain unchanged as migration references.

## IPC

`invoke('desktop_request', {action, payload})` returns JSON data or rejects with
`{code,message}`. No credentials or unrestricted filesystem/SQL command in IPC.
`invoke('desktop_cancel')` cancels the current model job; existing results survive.
Development/QA may use a debug-only Rust stdio driver, never fake localStorage.

Actions and payloads:

- profile_get -> `{profile: null|{nickname,defaultSubject},dataDirectory}`
- profile_save `{nickname,defaultSubject:'math'}` -> `{profile}`
- bootstrap -> `{config}` (existing assembly config + model configured status)
- students_list `{query?}` -> `{students}`
- students_create `{name,grade?,operationId}` -> `{student}`
- history_list -> `{drafts,papers}` (summaries; preserve creation order)
- intake_prepare `{requirements,message,mode:'llm'|'rule'}` -> `{requirements,summary,warnings}`
- blueprint_plan `{requirements,mode:'llm'|'rule'}` -> `{blueprint}`
- blueprint_check `{blueprint}` -> `{blueprint}`
- draft_create `{blueprint,mode:'llm'|'rule'}` -> `{draft}`
- draft_get `{draftId}` -> `{draft}`
- draft_operation `{draftId,operation:{type,operationId,expectedRevision,...}}` -> `{draft}`
- draft_candidates `{draftId,slotId}` -> `{candidates}`
- paper_confirmation `{draftId}` -> `{summary}`
- paper_confirm `{draftId,operationId,expectedRevision,acknowledgeDifferences}` -> `{paper}`
- paper_get `{paperId}` -> `{paper}`
- paper_derive `{paperId,operationId}` -> `{draft}`
- bank_catalog -> `{textbooks:[{id,title,volume,readyCount,chapters:[{id,title,number,readyCount,sections:[{id,title,number,readyCount,knowledge:[{uid,name,parentUid,readyCount,mappingStatus,reviewStatus,relation}]}]}]}],knowledgePoints:[{uid,name,parentUid,isLeaf,readyCount,children}],readyCount}`
- bank_search `{query?,questionType?,mainScope?,knowledgeUid?,includeDescendants?:true,page?,pageSize?}` -> `{questions,total,page,pageSize}`
- feedback_save `{paperId,willingToUse,reason?,manualCorrections?}` -> `{feedback}`
- model_get -> `{schemaVersion:2,revision,activeProfileId,profiles:[{id,name,baseUrl,model,hasApiKey,configured,warning}],baseUrl,model,hasApiKey,configured,warning:null|string}`; top-level fields describe only the active profile
- model_save `{expectedRevision,activeProfileId:string|null,profiles:[{id,name,baseUrl,model,apiKey?}]}` -> same public metadata; never return API key
- Legacy model_save `{baseUrl,model,apiKey?}` remains compatible and edits the active profile (or creates the first profile).
- Empty/omitted apiKey retains only that same profile ID's protected key. A new profile never inherits a key; changing endpoint origin requires a freshly supplied key. Empty profiles with activeProfileId null explicitly disables model use, including debug environment fallback on restart.
- Configuration changes are local and send no provider requests. Only the selected active profile is used by subsequent model operations, without automatic provider fallback. Full settings snapshots require the latest revision and commit together, preserving the previous file on validation or write failure.
- pdf_export `{paperId,kind:'student'|'teacher'}` (root integration)
- pdf_read `{paperId,kind}` -> `{paperId,kind,dataBase64,sha256,layoutVersion}`; only generated output of this paper/version, hash verified and path bounded

### Local paper import

- imports_list -> `{imports}`
- import_get `{importId}` -> `{import}`
- import_prepare new `{filename,contentBase64,operationId}` or retry `{importId,expectedRevision,operationId}` -> `{import}`
- import_review_save `{importId,operationId,expectedRevision,questions}` -> `{import}`
- import_publish `{importId,operationId,expectedRevision,acknowledgeReview:true}` -> `{import,publication}`

Import preparation requires a configured model before file decode, extraction,
storage or provider requests. Listing existing local imports and reviewing them
does not call the model. Original files and failed/pending results stay local;
only explicitly approved valid questions enter the bank. Reviewer fields use
stable `questionId`, `questionType`, `stem`, `options`, `answer`, `solution`,
`sectionIds`, `task:{id?,label}`, `knowledgeUids`, `knowledgeTopics`, and
`reviewDecision:'approve'|'pending'|'reject'`. Model suggestions begin pending.
Preserve `pages`, `sourceLabel`, `parts:[{partId,prompt,answer,solution}]`.
Approval requires explicit `reviewChecks:{sourceMatched,answerChecked,solutionChecked,formulaChecked}`
and nonempty `reviewBasis`; source-content blockers cannot be acknowledged away.
`mappingConfirmed`, `requiredSectionIds`, `requiredPremises`, `allowedSolution`
control separately reviewed automatic-assembly eligibility.
Import records carry revision, original source hash, extracted pages, source issues,
operation receipts, publication history and optional pendingPublication checkpoint.
Exact-record CAS prevents stale windows overwriting review; a bank-committed/personal-receipt-lost
publication replays the original operation and manifest. Never invent a new operation to hide an uncertain result.

## Data shape and implementation ownership

Keep existing `requirements`, `blueprint.slots`, `draft.baseline`, `draft.slots`,
question `student/teacher`, frozen `paper.draft` shapes where practical. Question
identity/version/hashes come from verified local seed or explicit local teacher publication, never model-generated.
Student metadata never enters model contexts or printed sheets. Math-only.

Rust `crate::error::{AppError,AppResult}` provides `AppError::new(code,message)`
and From conversions for rusqlite/serde_json/io. Root owns error.rs.

Storage agent owns `storage.rs` and `bank.rs`:

```
Store { pub user: rusqlite::Connection, pub bank: LocalQuestionBank,
        pub data_dir: PathBuf }
Store::open(data_dir: &Path, seed: &Value) -> AppResult<Store>
Store::profile() -> AppResult<Option<Value>>
Store::save_profile(nickname:&str, subject:&str) -> AppResult<Value>
Store::students(query:&str) -> AppResult<Vec<Value>>
Store::create_student(input:&Value) -> AppResult<Value>
Store::student(id:&str) -> AppResult<Value>
Store::list_documents(kind:&str) -> AppResult<Vec<Value>> // full documents newest-created first
Store::document(kind:&str,id:&str) -> AppResult<Value>
Store::put_document(kind:&str,id:&str,value:&Value) -> AppResult<()> // transaction handled by caller
```

Personal DB schema documents `(kind TEXT,id TEXT,payload TEXT, PRIMARY KEY(kind,id))`;
immutable paper updates rejected, one frozen paper per sourceDraftId; other tables
owned by storage. Domain can use `store.user.execute_batch("BEGIN IMMEDIATE")` /
COMMIT/ROLLBACK for operation replay and revisions. Root serializes IPC jobs.

BankRepository trait: `config() -> AppResult<Value>`,
`questions() -> AppResult<Vec<Value>>`, `question(id:&str) -> AppResult<Value>`.
LocalQuestionBank implements it using separate `question-bank.sqlite`.
Seed JSON root `{schemaVersion:1,config,questions}`. Profile DB is `personal.sqlite`.
No destructive reset or reading old web DB automatically.

Domain agent owns `assembly.rs`, `intake.rs`:
`pub fn dispatch(store:&mut Store, action:&str,payload:&Value,
 model:&crate::model::ModelClient,cancel:&AtomicBool)->AppResult<Option<Value>>`.
Return None for actions owned by root. Reuse bank trait via import.
ModelClient `configured()->bool`, `propose(task:&str,context:&Value,cancel:&AtomicBool)->AppResult<Value>`.
Root owns model.rs, profile/settings/history/student handlers, Tauri shell and build.

Frontend agent owns only `desktop/src/**`: Solid TSX and styles. Bridge module
uses IPC above; build configurations and index.html live inside desktop/. Root package.json only forwards desktop commands. No React or legacy web runtime.
Reuse existing CSS tokens/visual structure. Preserve explicit stage confirmations,
teacher quantity, empty positions, type Tabs, inline student mention, whole-paper
student/teacher preview and rename. No speculative teaching analytics.
