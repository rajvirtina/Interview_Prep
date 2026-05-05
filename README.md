# Interview Prep Deployment

This repository is configured for split hosting:

 - Frontend on Hostinger static hosting
 - Backend on Render as a Node web service

The frontend already supports a production API base URL through `VITE_API_URL`. In local development, leaving that variable empty keeps the existing Vite `/api` proxy behavior.

## Local development

Frontend:

```bash
npm install
npm run dev
```

Backend:

```bash
cd backend
npm install
cp .env.example .env
npm start
```

Local backend URL:

```text
http://localhost:8787
```

## Frontend deployment on Hostinger

1. Create a root `.env` file from `.env.example`.
2. Set the Render backend URL before building:

```bash
VITE_API_URL=https://your-render-service.onrender.com
```

3. Build the frontend:

```bash
npm run build
```

4. Upload everything inside `dist/` to Hostinger `public_html/`.

This repo now includes `public/.htaccess`, so the generated `dist/` folder contains Apache rewrite rules for SPA routing on Hostinger.

## Backend deployment on Render

This repo now includes `render.yaml` for the backend service.

Required Render environment variables:

- `GEMINI_API_KEY`
- `CORS_ORIGIN`

Optional Render environment variables:

- `GEMINI_MODEL`
- `GEMINI_FALLBACK_MODELS`
- `GEMINI_TIMEOUT_MS`

Example `CORS_ORIGIN` value:

```text
https://yourdomain.com
```

For multiple allowed origins, use a comma-separated list.

Render health check path:

```text
/api/health
```

## Deployment files in this repo

- `render.yaml`
- `public/.htaccess`
- `.env.example`
- `backend/.env.example`

## Security note

The repo currently contains a tracked `backend/.env` file. `.gitignore` has been updated so future local secrets stay untracked, but the existing checked-in secret should still be rotated and removed from version control in a follow-up change.
# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
