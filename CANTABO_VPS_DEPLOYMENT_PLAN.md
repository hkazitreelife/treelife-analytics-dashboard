# Cantabo VPS 0-to-1 Production Deployment Plan

This is a production-approved, step-by-step deployment guide to deploy the **Treelife AI Executive Workspace** to a **Cantabo Cloud VPS** with Docker, Nginx, automated SSL, and zero ongoing cloud database fees.

---

## 1. 🏗️ Architecture on Cantabo VPS

```mermaid
flowchart TD
    subgraph Internet [Public Traffic]
        User["Executive Users (Web Browser)"]
    end

    subgraph CantaboVPS ["Cantabo VPS S (Ubuntu 24.04 LTS / 8GB RAM / 50GB NVMe)"]
        Nginx["Nginx Reverse Proxy\n(Ports 80 & 443 + Let's Encrypt SSL)"]
        
        subgraph DockerNetwork ["Isolated Docker Bridge Network"]
            WebApp["Next.js 15 Web Container\n(Port 3000)"]
            Worker["BullMQ Worker Container\n(Background Daemon)"]
            Postgres["PostgreSQL 16 Container\n(Volume: postgres_prod_data)"]
            Redis["Redis 7 Container\n(Volume: redis_prod_data)"]
        end
    end

    subgraph ExternalAPIs [External AI Providers]
        ClaudeAPI["Anthropic Claude 3.5 Sonnet"]
        GeminiAPI["Google Gemini 2.5 Flash"]
    end

    User -->|HTTPS :443| Nginx
    Nginx -->|Proxy :3000| WebApp
    WebApp -->|SQL| Postgres
    WebApp -->|Push Jobs| Redis
    Worker -->|Pull Jobs| Redis
    Worker -->|Updates| Postgres
    Worker -->|Metadata Extraction| GeminiAPI
    Worker -->|Dashboard Generation| ClaudeAPI
    WebApp -->|Copilot Edits| ClaudeAPI
```

---

## 2. 📋 Prerequisites

1. **Cantabo Cloud VPS S** (~$5.50/mo):
   - **OS:** Ubuntu 24.04 LTS (64-bit)
   - **Specs:** 4 vCPU, 8 GB RAM, 50 GB NVMe Storage
2. **Domain Name** (e.g. `analytics.yourcompany.com` or `dashboard.treelife.in`).
3. **API Keys:** `ANTHROPIC_API_KEY` and `GEMINI_API_KEY`.

---

## 3. 🚀 Step-by-Step 0-to-1 Deployment Instructions

### Step 1: Connect to your Cantabo VPS via SSH
Open your terminal (PowerShell or macOS/Linux Terminal) and connect as root:
```bash
ssh root@<YOUR_CANTABO_VPS_IP>
```
*(Enter the root password provided by Cantabo in your confirmation email).*

---

### Step 2: Install Docker & Docker Compose (1 Command)
Run the official Docker automated installation script:
```bash
# Update Ubuntu packages
apt update && apt upgrade -y

# Install Docker & Compose plugin
curl -fsSL https://get.docker.com | sh

# Verify Docker installation
docker --version
docker compose version
```

---

### Step 3: Clone Your Git Repository
```bash
# Navigate to /opt or your home directory
cd /opt

# Clone repository
git clone https://github.com/<YOUR_USERNAME>/<YOUR_REPO_NAME>.git analytics-dashboard
cd analytics-dashboard
```

---

### Step 4: Configure Production Environment File (`.env`)
Create your production `.env` configuration file:
```bash
nano .env
```
Paste the following values (replace with your real keys & passwords):
```ini
# Production Environment
NODE_ENV=production
PAYLOAD_SECRET=treelife_super_secure_random_32_char_secret_key_here

# Database Credentials
POSTGRES_USER=postgres
POSTGRES_PASSWORD=CreateYourStrongDatabasePassword2026!
POSTGRES_DB=analytics_dashboard

# Admin Login Account
ADMIN_EMAIL=admin@treelife.com
ADMIN_INITIAL_PASSWORD=YourStrongAdminPassword123!

# AI Model Keys
GEMINI_API_KEY=AIzaSyYourGeminiApiKeyHere
ANTHROPIC_API_KEY=sk-ant-api03-YourAnthropicKeyHere
ANTHROPIC_MODEL=claude-sonnet-5
```
*(Press `Ctrl + O` then `Enter` to save, and `Ctrl + X` to exit).*

---

### Step 5: Start the Full Stack with Docker Compose
Run the production build:
```bash
docker compose -f docker-compose.prod.yml up -d --build
```
This automatically builds and boots:
* 🟢 **PostgreSQL 16** (Database)
* 🟢 **Redis 7** (BullMQ Job Queue)
* 🟢 **Next.js 15 Web Application** (Port 3000)
* 🟢 **BullMQ Background AI Worker** (Processing uploads 24/7)

Check container status:
```bash
docker compose -f docker-compose.prod.yml ps
```

---

### Step 6: Seed the Admin Account
Run the admin seed script inside the running web container:
```bash
docker compose -f docker-compose.prod.yml exec web pnpm --filter @analytics/web seed:admin
```
*(You will see: `Admin user admin@treelife.com verified / created successfully`)*.

---

### Step 7: Configure Nginx & Free SSL Certificate (HTTPS)

1. **Install Nginx & Certbot:**
   ```bash
   apt install nginx certbot python3-certbot-nginx -y
   ```

2. **Configure Nginx Reverse Proxy:**
   ```bash
   nano /etc/nginx/sites-available/analytics
   ```
   Paste the following configuration (replace `dashboard.yourdomain.com` with your real domain):
   ```nginx
   server {
       server_name dashboard.yourdomain.com;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_buffering off;
           proxy_read_timeout 300s;
           proxy_connect_timeout 300s;
       }

       client_max_body_size 100M;
   }
   ```

3. **Enable Site & Obtain Free SSL:**
   ```bash
   ln -s /etc/nginx/sites-available/analytics /etc/nginx/sites-enabled/
   nginx -t
   systemctl reload nginx

   # Obtain free Let's Encrypt SSL certificate
   certbot --nginx -d dashboard.yourdomain.com
   ```

---

## 4. 🔄 How to Push Updates & Features in 10 Seconds

Whenever you edit UI components or add features with Claude on your PC:
```bash
# On your local PC:
git add .
git commit -m "feat: added new chart component"
git push origin main

# On your Cantabo VPS (via SSH):
cd /opt/analytics-dashboard
git pull
docker compose -f docker-compose.prod.yml up -d --build web worker
```
Your live site is updated seamlessly with zero downtime!

---

## 5. 🛠️ Useful Management Commands

| Task | Command |
| :--- | :--- |
| **View Web Logs** | `docker compose -f docker-compose.prod.yml logs -f web` |
| **View Worker Logs** | `docker compose -f docker-compose.prod.yml logs -f worker` |
| **Restart Everything** | `docker compose -f docker-compose.prod.yml restart` |
| **Database Backup** | `docker compose -f docker-compose.prod.yml exec postgres pg_dump -U postgres analytics_dashboard > backup.sql` |
| **Check Disk Usage** | `df -h` |
