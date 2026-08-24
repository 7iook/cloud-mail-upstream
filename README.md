<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center">基于 Cloudflare 的简约响应式邮箱服务，支持邮件发送、附件收发 🎉</p> 
    <p align="center">
        简体中文 | <a href="/README-en.md" style="margin-left: 5px">English </a>
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


## 项目简介

只需要一个域名，就可以创建多个不同的邮箱，类似各大邮箱平台，本项目支持署到 Cloudflare Workers ，降低服务器成本，搭建自己的邮箱服务

## 项目展示

- [在线演示](https://skymail.ink)<br>
- [部署文档](https://doc.skymail.ink)<br>

| ![](/doc/demo/demo1.png) | ![](/doc/demo/demo2.png) |
|-----------------------|-----------------------|
| ![](/doc/demo/demo3.png) | ![](/doc/demo/demo4.png) |




## 功能介绍

- **💰 低成本使用**： 可部署到 Cloudflare Workers 降低服务器成本

- **💻 响应式设计**：响应式布局自动适配PC和大部分手机端浏览器

- **📧 邮件发送**：集成Resend发送邮件，支持群发，内嵌图片和附件发送，发送状态查看

- **🛡️ 管理员功能**：可以对用户，邮件进行管理，RABC权限控制对功能及使用资源限制

- **📦 附件收发**：支持收发附件，使用R2对象存储保存和下载文件

- **🔔 邮件推送**：接收邮件后可以转发到TG机器人或其他服务商邮箱

- **📡 开放API**：支持使用API批量生成用户，多条件查询邮件 

- **🔢 验证码识别**：使用Workers AI，自动识别邮件验证码 

- **📈 数据可视化**：使用ECharts对系统数据详情，用户邮件增长可视化显示

- **🎨 个性化设置**：可以自定义网站标题，登录背景，透明度

- **🤖 人机验证**：集成Turnstile人机验证，防止人机批量注册

- **🔗 邮箱分享**：用一条不可猜的链接，把一个或多个邮箱在限定时间内只读交给未登录访客，支持会话次数上限、可选访问密钥与验证码提取（多邮箱与访问密钥需平台启用）

- **📜 更多功能**：正在开发中...



## 技术栈

- **平台**：[Cloudflare Workers](https://developers.cloudflare.com/workers/)

- **Web框架**：[Hono](https://hono.dev/)

- **ORM：**[Drizzle](https://orm.drizzle.team/)

- **前端框架**：[Vue3](https://vuejs.org/) 

- **UI框架**：[Element Plus](https://element-plus.org/) 

- **邮件推送：** [Resend](https://resend.com/)

- **缓存**：[Cloudflare KV](https://developers.cloudflare.com/kv/)

- **数据库**：[Cloudflare D1](https://developers.cloudflare.com/d1/)

- **文件存储**：[Cloudflare R2](https://developers.cloudflare.com/r2/)

## 目录结构

```
cloud-mail
├── mail-worker				    # worker后端项目
│   ├── src                  
│   │   ├── api	 			    # api接口层			
│   │   ├── const  			    # 项目常量
│   │   ├── dao                 # 数据访问层
│   │   ├── email			    # 邮件处理接收
│   │   ├── entity			    # 数据库实体
│   │   ├── error			    # 自定义异常
│   │   ├── hono			    # web框架配置、拦截器、全局异常等
│   │   ├── i18n			    # 语言国际化
│   │   ├── init			    # 数据库缓存初始化
│   │   ├── model			    # 响应体数据封装
│   │   ├── security			# 身份权限认证
│   │   ├── service			    # 业务服务层
│   │   ├── template			# 消息模板
│   │   ├── utils			    # 工具类
│   │   └── index.js			# 入口文件
│   ├── pageckge.json			# 项目依赖
│   └── wrangler.toml			# 项目配置
│
├── mail-vue				    # vue前端项目
│   ├── src
│   │   ├── axios 			    # axios配置
│   │   ├── components			# 自定义组件
│   │   ├── echarts			    # echarts组件导入
│   │   ├── i18n			    # 语言国际化
│   │   ├── init			    # 入站初始化
│   │   ├── layout			    # 主体布局组件
│   │   ├── perm			    # 权限认证
│   │   ├── request			    # api接口
│   │   ├── router			    # 路由配置
│   │   ├── store			    # 全局状态管理
│   │   ├── utils			    # 工具类
│   │   ├── views			    # 页面组件
│   │   ├── app.vue			    # 入口组件
│   │   ├── main.js			    # 入口js
│   │   └── style.css			# 全局css
│   ├── package.json			# 项目依赖
└── └── env.release				# 项目配置
```

## 分享功能部署配置

分享功能依赖两把密钥。**这两把没配好,创建第一条分享就会失败**,所以部署时请先走完这一节。

### 1. 生成两把密钥

两把要各生成一次,不要复用同一个值:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 2. 线上:用 `wrangler secret put` 配置

在 `mail-worker` 目录下执行,命令会提示你粘贴上一步生成的值:

```bash
cd mail-worker
npx wrangler secret put SHARE_SEC_PEPPER
npx wrangler secret put SHARE_SESSION_SIGNING_KEY
```

密钥**不要**写进 `wrangler.toml` 的 `[vars]`——那一段是明文,会随代码一起进仓库。

| 变量名 | 必需 | 不配会怎样 |
|---|---|---|
| `SHARE_SEC_PEPPER` | 是 | 创建分享失败,响应体 `{"code":500,"message":"share create pepper missing"}` |
| `SHARE_SESSION_SIGNING_KEY` | 是 | 分享能建出来,但访客打开链接时签发会话失败,响应体 `{"code":501,"message":"SHARE_UNAVAILABLE"}` |
| `SHARE_SEC_PEPPER_KID` | 否 | 默认 `v1`,只有轮换密钥时才需要显式指定 |
| `SHARE_MAX_DURATION_SECONDS` | 否 | **不配即分享有效期无上限**。要约束就填正整数秒数,如 `86400`(1 天) |
| `SHARE_CAPABILITY_V2` | 否 | 缺失即关闭,见下方取值陷阱 |

> **排查时别只看 HTTP 状态码。** 本项目的接口即使出错,HTTP 状态码也是 `200`,真正的错误在响应体的 `code` 字段里。上面两条都是实测结果。Worker 侧的日志(`npx wrangler tail`)会额外打出 `share create sec pepper missing` / `share-auth session signing key missing`。

其余可选项(总开关 `SHARE_ENABLED`、链接域名 `SHARE_PUBLIC_ORIGIN`、会话时长 `SHARE_SESSION_TTL` 等)连同默认值都列在 `mail-worker/.dev.vars.example` 里。

### 3. 本地开发:用 `.dev.vars`

```bash
cd mail-worker
cp .dev.vars.example .dev.vars   # Windows PowerShell: Copy-Item .dev.vars.example .dev.vars
```

然后把文件里的 `replace-me-...` 占位值换成第 1 步生成的真串。`.dev.vars` 已被 `.gitignore` 忽略,只作用于本地 `wrangler dev`。

### ⚠️ `SHARE_CAPABILITY_V2` 的两个坑

**取值大小写敏感。** 代码只认 `"1"` / `"true"` / `1` / `true` 这四种,写成 `"TRUE"` 或 `"True"` 会被**静默判为关闭,且不报任何错**。

**线上只能在 Cloudflare Dashboard 配。** `wrangler.toml` 里那行 `#SHARE_CAPABILITY_V2` 请保持注释状态:`keep_vars` 拦不住 toml 里显式写出来的值,一旦取消注释,下次部署就会把 Dashboard 上的 `true` 覆盖回 `false`。本地开发不受此限,写 `.dev.vars` 即可。

## 赞助

<a href="https://doc.skymail.ink/support.html" >
<img width="170px" src="./doc/images/support.png" alt="">
</a>

## 许可证

本项目采用 [MIT](LICENSE) 许可证	


## 交流

[Telegram](https://t.me/cloud_mail_tg)



