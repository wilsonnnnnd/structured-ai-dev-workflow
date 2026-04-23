# structured-ai-dev-workflow

A lightweight, project-aware AI development workflow that turns vague coding requests into structured, safe, and executable implementation tasks.

Designed for real-world use with:
- GitHub Copilot
- OpenAI Codex / ChatGPT
- Trae
- Claude / skill-based systems

---

## ✨ Why

AI coding tools are powerful, but they often:

- don’t understand your project structure
- ignore reusable components and utilities
- break shared modules
- generate inconsistent UI/code patterns
- skip clarification and jump straight to code

This project solves that by introducing a **structured AI workflow system**:

👉 instead of writing prompts  
👉 you enforce a development process

---

## 🧠 Core Idea

Every request goes through a controlled pipeline:
User Request
↓
Project Context (what exists)
↓
Engineering Rules (what is allowed)
↓
Skill Router (what to do)
↓
Skill Execution
↓
Prompt / Plan Output
↓
AI Coding Tool (Copilot / Codex / Trae)


---

## 🧩 Architecture

### 1. Project Context (`/ai/project.md`)
Defines:
- tech stack
- folder structure
- reusable components
- UI system
- risk areas

👉 answers: *"what is this project?"*

---

### 2. Engineering Rules (`/ai/rules.md`)
Defines:
- reuse-first policy
- shared module protection
- UI constraints
- scope control

👉 answers: *"what is allowed?"*

---

### 3. Skill System (`/.claude/skills/`)
Split into:

- `project-scan` → understand project structure
- `prompt-design` → generate implementation prompt
- `prompt-review` → enforce quality & constraints

👉 answers: *"how should AI behave?"*

---

### 4. Task Entry (`/ai/task-entry.md`)
The entry point for every request.

Includes:
- smart routing logic
- constraints
- output rules

👉 answers: *"how do we start?"*

---

### 5. Testing (`/ai/tests/test-case.md`)
Used to validate:

- AI follows rules
- AI chooses correct skill
- AI does NOT generate unsafe outputs

---
