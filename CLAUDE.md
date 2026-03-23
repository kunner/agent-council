# Agent Council

Multi-team AI agent orchestration system. AI 에이전트 팀의 리더들이 Council Room에서 회의하며 실제 코드를 개발하는 플랫폼.

## Project Structure

pnpm monorepo with 3 packages:
- `packages/shared` — Shared TypeScript types and constants
- `packages/server` — Express + Socket.IO + Firebase Admin (port 3001)
- `packages/web` — React + Vite + Tailwind + Firebase Auth (port 5173)

## Commands

- `pnpm dev` — Start server + web concurrently
- `pnpm build` — Build all packages (shared → server → web)
- `pnpm typecheck` — TypeScript check all packages
- `pnpm --filter @agent-council/server dev` — Server only
- `pnpm --filter @agent-council/web dev` — Web only

## Tech Stack

- **Runtime**: Node.js 20+, pnpm 9+
- **Server**: Express 4, Socket.IO 4, Firebase Admin SDK
- **Web**: React 18, Vite 5, Tailwind CSS 3, Zustand 5
- **Database**: Firestore (Firebase Spark plan)
- **Auth**: Firebase Auth (Google OAuth)
- **AI**: Claude Code CLI (subprocess)

## Conventions

- All shared types are in `packages/shared/src/types/index.ts` — NEVER duplicate types in server or web
- Use `.js` extensions in imports for NodeNext module resolution (server/shared)
- Web uses Bundler module resolution (no `.js` extensions needed)
- Firestore collection paths always under `projects/{projectId}/...`
- Server port: 3001, Web dev port: 5173
- Dark mode by default, Tailwind for styling
- Korean UI text, English code/comments

## Environment

- Server `.env` at `packages/server/.env`
- Web `.env.local` at `packages/web/.env.local`
- Firebase project: `agent-council-53d5e`
- Never commit `.env` files or service account keys
