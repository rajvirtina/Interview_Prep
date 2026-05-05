# Hostinger Frontend Deployment

This frontend is ready to deploy to Hostinger as a static Vite build, with the backend deployed separately to Render.

## 1. Set the production backend URL

Before building, create a root `.env` file from `.env.example` and set:

```bash
VITE_API_URL=https://your-render-service.onrender.com
```

That value is compiled into the frontend build, so it must be present before running `npm run build`.

## 2. Build the frontend

```bash
npm install
npm run build
```

The production output is generated in `dist/`.

## 3. Upload to Hostinger

Upload all contents of `dist/` into `public_html/`.

Required file to keep:

- `.htaccess`

This repo now includes `public/.htaccess`, and Vite copies it into `dist/` automatically.

## 4. Verify after upload

1. Open your Hostinger domain.
2. Confirm the app loads.
3. Confirm browser network requests go to your Render backend URL.
4. Confirm the backend health endpoint responds:

```text
https://your-render-service.onrender.com/api/health
```

## Common issues

### API requests still go to `/api`

You built without `VITE_API_URL` set. Rebuild locally, then re-upload `dist/`.

### Refreshing the page returns 404

The `.htaccess` file was not uploaded to `public_html/`.

### CORS blocked in the browser

Set Render `CORS_ORIGIN` to your Hostinger origin, for example:

```text
https://yourdomain.com
```

For multiple frontend origins, use a comma-separated value.

## Recommended deployment order

1. Deploy the backend to Render first.
2. Copy the final Render service URL.
3. Build the frontend with `VITE_API_URL` set to that URL.
4. Upload the new `dist/` bundle to Hostinger.
# Interview Prep App - Hostinger Deployment Guide

## Quick Start

This frontend React app is ready to deploy on Hostinger. Follow these steps:

## Prerequisites
- Hostinger account with cPanel access
- FTP/File Manager access or Terminal/SSH access
- A domain or subdomain pointing to your Hostinger hosting

## Deployment Steps

### 1. **Build the App** (Already Done)
```bash
npm run build
```
This creates a `dist/` folder with production-optimized files. All files are already included.

### 2. **Upload to Hostinger**

#### Option A: Using File Manager (Easiest)
1. Log in to your Hostinger cPanel
2. Go to **File Manager**
3. Navigate to your domain's root folder (usually `public_html/`)
4. Delete any existing files if you want a fresh install
5. Upload all files from the `dist/` folder to `public_html/`
   - The `.htaccess` file must be included for proper routing
   - Make sure "Show Hidden Files" is enabled to see `.htaccess`

#### Option B: Using FTP
1. Download an FTP client (FileZilla, WinSCP, etc.)
2. Connect using credentials from Hostinger's FTP settings
3. Navigate to `public_html/`
4. Drag and drop all files from `dist/` folder
5. Ensure `.htaccess` is uploaded

#### Option C: Using Terminal/SSH
```bash
# From your local machine with SSH access
scp -r dist/* your_user@your_hostinger_ip:/home/your_user/public_html/
```

### 3. **Configure Permissions**
- Set folder permissions to `755`
- Set file permissions to `644`
  
This is usually automatic on Hostinger, but you can verify in File Manager:
1. Right-click folder → "Change Permissions"
2. Set to 755 for folders
3. Set to 644 for files

### 4. **Verify Deployment**
1. Open your domain in a browser: `https://yourdomain.com`
2. You should see the Interview Prep AI app
3. Test the form and question generation

## Important Notes

### About the API
- The current app makes direct calls to Anthropic API (`https://api.anthropic.com/v1/messages`)
- **This will NOT work** because:
  - Hostinger doesn't allow direct API calls from browsers to external services
  - Your Anthropic API key would be exposed in browser network requests
  
### Solution Options

#### Option 1: Use Your Own Backend (Recommended)
Create a backend service on:
- **Render.com** (free tier, perfect for this)
- **Railway.app**
- **Fly.io**
- Or any Node.js hosting

Then modify the frontend to call your backend API instead of Anthropic directly.

#### Option 2: Use Vercel Edge Functions
Deploy a simple serverless function to proxy API calls securely.

#### Option 3: Use Built-in Question Bank
The app has a fallback 120+ question bank that works without AI:
- Currently it tries AI first, then falls back
- Users will see real questions even if AI is unavailable

## Project Structure

```
dist/
  ├── index.html          # Main entry point
  ├── .htaccess           # Apache routing config
  ├── assets/
  │   ├── index-*.css     # Bundled CSS
  │   └── index-*.js      # Bundled JavaScript
```

## Troubleshooting

### White screen or 404 errors
- Verify `.htaccess` is uploaded to `public_html/`
- Check that all files from `dist/` were uploaded
- Ensure the domain/subdomain is properly pointing to `public_html/`

### Questions won't load
- This is expected if you haven't set up a backend
- The app will fall back to the built-in question bank
- See "Solution Options" above to enable AI

### CORS errors in browser console
- This confirms the app can't reach Anthropic API directly (expected)
- This is why you need a backend proxy

## Next Steps

To enable AI-powered questions:
1. Create a Node.js backend on Render.com or similar
2. Update the frontend to call your backend API
3. Store Anthropic API key securely on the backend
4. Redeploy frontend with the backend URL

## Support

For Hostinger-specific help:
- Visit Hostinger's support center
- Check cPanel documentation
- Verify domain DNS settings point to Hostinger nameservers

## File Sizes

After `npm run build`:
- `index.html`: ~460 bytes
- CSS bundle: ~70 bytes (gzipped)
- JS bundle: ~246 KB (~79 KB gzipped)

Total: ~250 KB before gzip, ~80 KB after gzip
