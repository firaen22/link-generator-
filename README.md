<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/b1c2e312-dc79-42db-aa14-8f2b88fd06ec

## Run Locally

**Prerequisites:** Node.js v18+

1. Install dependencies:
   ```bash
   npm install
   ```
2. Set the environment variables in `.env` based on `.env.example`:
   ```bash
   cp .env.example .env
   ```
   Provide your Gemini API key and any Telegram Bot tokens if required.
3. Run the application in development mode:
   ```bash
   npm run dev
   ```
   *The server will start at `http://localhost:3000`.*
4. To build for production:
   ```bash
   npm run build
   ```
   *The output will be inside the `dist` folder.*
5. To start the production server:
   ```bash
   npm start
   ```

## Deployment
This project includes a continuous integration and deployment workflow for GitHub Actions(`.github/workflows/deploy.yml`).

### Deploy via VPS (SSH + PM2)
If you are deploying to a Virtual Private Server (VPS), you can uncomment the `deploy` job in `.github/workflows/deploy.yml`. 
You must configure the following **GitHub Secrets**:
- `SERVER_HOST`: Your server IP address
- `SERVER_USER`: Your SSH username (e.g., `root`, `ubuntu`)
- `SERVER_SSH_KEY`: Your SSH private key

The action will connect to the server, pull the latest code, build it, and restart it using PM2.

### Deploy via Render / Railway / Heroku
Since this is a Node.js full-stack app (Express server on port 3000), you can directly link your GitHub repository to Render or Railway.
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
