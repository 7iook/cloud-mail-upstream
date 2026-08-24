<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center">A simple, responsive email service designed to run on Cloudflare Workers 🎉</p> 
    <p align="center">
       <a href="/README.md" style="margin-left: 5px">简体中文</a> | English 
    </p>
    <p align="center">
        <a href="https://github.com/maillab/cloud-mail/tree/main?tab=MIT-1-ov-file" target="_blank" >
            <img src="https://img.shields.io/badge/license-MIT-green" />
        </a>    
        <a href="https://github.com/maillab/cloud-mail/releases" target="_blank" >
            <img src="https://img.shields.io/github/v/release/maillab/cloud-mail" alt="releases" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/issues" >
            <img src="https://img.shields.io/github/issues/maillab/cloud-mail" alt="issues" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/stargazers" target="_blank">
            <img src="https://img.shields.io/github/stars/maillab/cloud-mail" alt="stargazers" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/forks" target="_blank" >
            <img src="https://img.shields.io/github/forks/maillab/cloud-mail" alt="forks" />
        </a>
    </p>
    <p align="center">
        <a href="https://trendshift.io/repositories/20459" target="_blank" >
            <img src="https://trendshift.io/api/badge/repositories/20459" alt="trendshift" >
        </a>
    </p>
</p>

## Description
With only one domain, you can create multiple different email addresses, similar to major email platforms. This project can be deployed on Cloudflare Workers to reduce server costs and build your own email service.
## Project Showcase

- [Live Demo](https://skymail.ink)<br>
- [Deployment Guide](https://doc.skymail.ink/en/)<br>


| ![](/doc/demo/demo1.png) | ![](/doc/demo/demo2.png) |
|--------------------------|--------------------------|
| ![](/doc/demo/demo3.png) | ![](/doc/demo/demo4.png) |

## Features

- **💰 Low-Cost Usage**: No server required — deploy to Cloudflare Workers to reduce costs.

- **💻 Responsive Design**: Automatically adapts to both desktop and most mobile browsers.

- **📧 Email Sending**: Integrated with Resend, supporting bulk email sending and attachments.

- **🛡️ Admin Features**: Admin controls for user and email management with RBAC-based access control.

- **📦 Attachment Support**: Send and receive attachments, stored and downloaded via R2 object storage.

- **🔔 Email Push**: Forward received emails to Telegram bots or other email providers.

- **📡 Open API**: Supports batch user creation via API and multi-condition email queries

- **🔢 Verification Code Recognition**: Auto-detect codes via Workers AI

- **📈 Data Visualization**: Use ECharts to visualize system data, including user email growth.

- **🎨 Personalization**: Customize website title, login background, and transparency.

- **🤖 CAPTCHA**: Integrated with Turnstile CAPTCHA to prevent automated registration.

- **🔗 Mailbox Sharing**: Hand one or more mailboxes to a signed-out visitor read-only for a limited time through a single unguessable link, with a session count limit, an optional access key and verification code extraction (multi-mailbox and access keys require the platform to enable them).

- **📜 More Features**: Under development...

## Tech Stack

- **Platform**: [Cloudflare Workers](https://developers.cloudflare.com/workers/)

- **Web Framework**: [Hono](https://hono.dev/)

- **ORM**: [Drizzle](https://orm.drizzle.team/)

- **Frontend Framework**: [Vue3](https://vuejs.org/)

- **UI Framework**: [Element Plus](https://element-plus.org/)

- **Email Service**: [Resend](https://resend.com/)

- **Cache**: [Cloudflare KV](https://developers.cloudflare.com/kv/)

- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/)

- **File Storage**: [Cloudflare R2](https://developers.cloudflare.com/r2/)

## Project Structure

```
cloud-mail
├── mail-worker				    # Backend worker project
│   ├── src                  
│   │   ├── api	 			    # API layer
│   │   ├── const  			    # Project constants
│   │   ├── dao                 # Data access layer
│   │   ├── email			    # Email processing and handling
│   │   ├── entity			    # Database entities
│   │   ├── error			    # Custom exceptions
│   │   ├── hono			    # Web framework, middleware, error handling
│   │   ├── i18n			    # Internationalization
│   │   ├── init			    # Database and cache initialization
│   │   ├── model			    # Response data models
│   │   ├── security			# Authentication and authorization
│   │   ├── service			    # Business logic layer
│   │   ├── template			# Message templates
│   │   ├── utils			    # Utility functions
│   │   └── index.js			# Entry point
│   ├── package.json			# Project dependencies
│   └── wrangler.toml			# Project configuration
│
├─ mail-vue				        # Frontend Vue project
│   ├── src
│   │   ├── axios 			    # Axios configuration
│   │   ├── components			# Custom components
│   │   ├── echarts			    # ECharts integration
│   │   ├── i18n			    # Internationalization
│   │   ├── init			    # Startup initialization
│   │   ├── layout			    # Main layout components
│   │   ├── perm			    # Permissions and access control
│   │   ├── request			    # API request layer
│   │   ├── router			    # Router configuration
│   │   ├── store			    # Global state management
│   │   ├── utils			    # Utility functions
│   │   ├── views			    # Page components
│   │   ├── app.vue			    # Root component
│   │   ├── main.js			    # Entry JS file
│   │   └── style.css			# Global styles
│   ├── package.json			# Project dependencies
└── └── env.release				# Environment configuration

```

## Share Feature Configuration

The share feature depends on two secrets. **If they are not set, creating the very first share will fail**, so walk through this section before deploying.

### 1. Generate the two secrets

Generate each one separately — do not reuse the same value for both:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 2. Production: set them with `wrangler secret put`

Run this from the `mail-worker` directory; the command prompts you to paste the value generated above:

```bash
cd mail-worker
npx wrangler secret put SHARE_SEC_PEPPER
npx wrangler secret put SHARE_SESSION_SIGNING_KEY
```

Do **not** put secrets in the `[vars]` block of `wrangler.toml` — that block is plain text and gets committed with the code.

| Variable | Required | What happens if unset |
|---|---|---|
| `SHARE_SEC_PEPPER` | Yes | Creating a share fails with the response body `{"code":500,"message":"share create pepper missing"}` |
| `SHARE_SESSION_SIGNING_KEY` | Yes | The share is created fine, but issuing a visitor session fails when someone opens the link: `{"code":501,"message":"SHARE_UNAVAILABLE"}` |
| `SHARE_SEC_PEPPER_KID` | No | Defaults to `v1`; only needs an explicit value during key rotation |
| `SHARE_MAX_DURATION_SECONDS` | No | **Unset means share lifetime is unbounded.** Set a positive number of seconds to cap it, e.g. `86400` (1 day) |
| `SHARE_CAPABILITY_V2` | No | Absent means disabled; see the pitfalls below |

> **Do not go by the HTTP status code when troubleshooting.** This project's API returns HTTP `200` even on failure; the real error lives in the `code` field of the response body. Both rows above are measured behaviour. The Worker log (`npx wrangler tail`) additionally prints `share create sec pepper missing` / `share-auth session signing key missing`.

The remaining optional variables (kill switch `SHARE_ENABLED`, link origin `SHARE_PUBLIC_ORIGIN`, session lifetime `SHARE_SESSION_TTL`, and others) are listed with their defaults in `mail-worker/.dev.vars.example`.

### 3. Local development: use `.dev.vars`

```bash
cd mail-worker
cp .dev.vars.example .dev.vars   # Windows PowerShell: Copy-Item .dev.vars.example .dev.vars
```

Then replace the `replace-me-...` placeholders with the real values from step 1. `.dev.vars` is already gitignored and only applies to local `wrangler dev`.

### ⚠️ Two pitfalls with `SHARE_CAPABILITY_V2`

**The value is case-sensitive.** The code only accepts `"1"` / `"true"` / `1` / `true`. Writing `"TRUE"` or `"True"` is **silently treated as disabled, with no error at all**.

**In production it can only be set from the Cloudflare Dashboard.** Keep the `#SHARE_CAPABILITY_V2` line in `wrangler.toml` commented out: `keep_vars` does not protect values written explicitly in the toml, so uncommenting it makes the next deploy overwrite the Dashboard's `true` back to `false`. Local development is not affected — just use `.dev.vars`.

## Sponsor

<a href="https://doc.skymail.ink/support.html">
<img width="170px" src="./doc/images/support.png" alt="">
</a>

## License

This project is licensed under the [MIT](LICENSE) license.

## Communication

[Telegram](https://t.me/cloud_mail_tg)
