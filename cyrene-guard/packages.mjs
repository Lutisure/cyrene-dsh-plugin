/**
 * 包名校验的两张种子表 —— **由 `tools/gen-packages.mjs` 从抽取出的规则文件生成，
 * 不要手改。**
 *
 * 来源：`Unclecheng-li/DeepSec` 的 `src/package/seedCatalog.ts`（MIT）。原文件的两个
 * 表就是硬编码的，重复一千多条包名只会引入转写错误，所以直接生成。
 *
 * ## 为什么需要它
 *
 * AI 写的代码**特别容易编出看起来合理的包名**。这个名字一旦落到磁盘上，就是一个
 * 现成的抢注目标 —— 攻击者注册它、放上恶意代码，下次安装就跑起来了。DeepSec 管这个
 * 叫 slopsquatting，它的提示词写着：
 *
 *   > This may be a slopsquatting risk: AI-generated code often invents plausible
 *   > package names.
 *
 * ## 两张表回答两个不同的问题
 *
 * `KNOWN` 是「这些确定存在」，`HALLUCINATED` 是「这些是编出来的，最近的真实替代是
 * 这些」。**两张表之外的名字一律是「不知道」** —— 不是「不存在」。分不清这两件事，
 * 规则就会变成一台误报机器，而误报的规则会被关掉。
 */

/** 确定存在的包，按 registry 分组。 */
export const KNOWN = {
  "npm": [
    "@angular/core",
    "@nestjs/common",
    "@reduxjs/toolkit",
    "@types/node",
    "axios",
    "bcrypt",
    "chalk",
    "commander",
    "cors",
    "dotenv",
    "express",
    "express-rate-limit",
    "fastify",
    "jsonwebtoken",
    "lodash",
    "mongoose",
    "next",
    "next-auth",
    "node-fetch",
    "pg",
    "prisma",
    "react",
    "react-dom",
    "react-router-dom",
    "react-virtualized",
    "react-window",
    "sqlite3",
    "typescript",
    "vite",
    "vue",
    "zod"
  ],
  "pypi": [
    "boto3",
    "celery",
    "django",
    "fastapi",
    "flask",
    "httpx",
    "jinja2",
    "numpy",
    "openai",
    "pandas",
    "pillow",
    "opencv-python",
    "psycopg2",
    "pydantic",
    "pytest",
    "python-dotenv",
    "pyyaml",
    "requests",
    "scikit-learn",
    "sqlalchemy",
    "torch",
    "torchvision",
    "transformers",
    "uvicorn",
    "slowapi",
    "fastapi-limiter",
    "django-allauth"
  ],
  "cargo": [
    "actix-web",
    "anyhow",
    "axum",
    "chrono",
    "clap",
    "diesel",
    "rand",
    "regex",
    "reqwest",
    "serde",
    "serde_json",
    "sqlx",
    "thiserror",
    "tokio",
    "tracing",
    "uuid"
  ],
  "gomod": [
    "github.com/gin-gonic/gin",
    "github.com/go-chi/chi",
    "github.com/golang-jwt/jwt/v5",
    "github.com/gorilla/mux",
    "github.com/jackc/pgx/v5",
    "github.com/labstack/echo/v4",
    "github.com/redis/go-redis/v9",
    "github.com/spf13/cobra",
    "github.com/stretchr/testify",
    "go.mongodb.org/mongo-driver",
    "go.uber.org/zap",
    "golang.org/x/crypto",
    "google.golang.org/grpc",
    "gorm.io/gorm"
  ],
  "maven": [
    "ch.qos.logback:logback-classic",
    "com.fasterxml.jackson.core:jackson-databind",
    "com.google.guava:guava",
    "com.squareup.okhttp3:okhttp",
    "io.jsonwebtoken:jjwt-api",
    "jakarta.validation:jakarta.validation-api",
    "junit:junit",
    "org.apache.commons:commons-lang3",
    "org.hibernate.validator:hibernate-validator",
    "org.junit.jupiter:junit-jupiter",
    "org.postgresql:postgresql",
    "org.springframework.boot:spring-boot-starter-data-jpa",
    "org.springframework.boot:spring-boot-starter-security",
    "org.springframework.boot:spring-boot-starter-web",
    "org.springframework.security:spring-security-core"
  ]
};

/** 已知的幻觉包，附最接近的真实替代。 */
export const HALLUCINATED = {
  "npm": [
    {
      "name": "react-virtualized-auto-sizer",
      "replacements": [
        "react-virtualized",
        "react-window"
      ]
    },
    {
      "name": "express-rate-limit-flex",
      "replacements": [
        "express-rate-limit"
      ]
    },
    {
      "name": "secure-jwt-auth",
      "replacements": [
        "jsonwebtoken"
      ]
    },
    {
      "name": "next-auth-middleware-secure",
      "replacements": [
        "next-auth"
      ]
    },
    {
      "name": "openai-vision-client",
      "replacements": [
        "openai"
      ]
    }
  ],
  "pypi": [
    {
      "name": "torch-vision-utils",
      "replacements": [
        "torchvision",
        "torch"
      ]
    },
    {
      "name": "fastapi-limiter-middleware",
      "replacements": [
        "slowapi",
        "fastapi-limiter"
      ]
    },
    {
      "name": "django-secure-auth",
      "replacements": [
        "django-allauth",
        "django"
      ]
    },
    {
      "name": "openai-secret-manager",
      "replacements": [
        "openai",
        "python-dotenv"
      ]
    },
    {
      "name": "pandas-ai-utils",
      "replacements": [
        "pandas"
      ]
    }
  ],
  "cargo": [
    {
      "name": "actix-web-secure-middleware",
      "replacements": [
        "actix-web"
      ]
    },
    {
      "name": "axum-auth-guard",
      "replacements": [
        "axum"
      ]
    },
    {
      "name": "reqwest-retry-plus",
      "replacements": [
        "reqwest"
      ]
    },
    {
      "name": "serde-secure-json",
      "replacements": [
        "serde",
        "serde_json"
      ]
    },
    {
      "name": "tokio-secure-auth",
      "replacements": [
        "tokio"
      ]
    }
  ],
  "gomod": [
    {
      "name": "github.com/gin-gonic/secure-gin",
      "replacements": [
        "github.com/gin-gonic/gin"
      ]
    },
    {
      "name": "github.com/gorilla/secure-mux",
      "replacements": [
        "github.com/gorilla/mux"
      ]
    },
    {
      "name": "github.com/spf13/secure-cobra",
      "replacements": [
        "github.com/spf13/cobra"
      ]
    },
    {
      "name": "golang.org/x/securecrypto",
      "replacements": [
        "golang.org/x/crypto"
      ]
    },
    {
      "name": "gorm.io/secure-gorm",
      "replacements": [
        "gorm.io/gorm"
      ]
    }
  ],
  "maven": [
    {
      "name": "com.fasterxml.jackson.core:jackson-databind-secure",
      "replacements": [
        "com.fasterxml.jackson.core:jackson-databind"
      ]
    },
    {
      "name": "io.jsonwebtoken:jjwt-secure-api",
      "replacements": [
        "io.jsonwebtoken:jjwt-api"
      ]
    },
    {
      "name": "org.postgresql:postgresql-secure",
      "replacements": [
        "org.postgresql:postgresql"
      ]
    },
    {
      "name": "org.springframework.boot:spring-boot-starter-secure-api",
      "replacements": [
        "org.springframework.boot:spring-boot-starter-security"
      ]
    },
    {
      "name": "org.springframework.security:spring-security-auth-magic",
      "replacements": [
        "org.springframework.security:spring-security-core"
      ]
    }
  ]
};

/**
 * 每个 registry 的存在性查询地址。
 *
 * `{name}` 会被替换成规范化之后的包名。这些是 DeepSec 逐字记录的地址，没有改。
 */
export const REGISTRY_URLS = {
  npm: 'https://registry.npmjs.org/{name}',
  pypi: 'https://pypi.org/pypi/{name}/json',
  cargo: 'https://crates.io/api/v1/crates/{name}',
  gomod: 'https://proxy.golang.org/{name}/@latest',
  maven: 'https://search.maven.org/solrsearch/select?q=g:"{group}" AND a:"{artifact}"&rows=1&wt=json'
};

/**
 * Go module proxy 要求的大写转义。
 *
 * 规范规定大写字母写成 `!` 加小写，而 `!` 本身写成 `!!`。漏了这条，凡是名字里带
 * 大写的 module 都会查不到 —— 而查不到会被当成「不存在」，于是报出一个假的幻觉包。
 * DeepSec 为此专门写了测试。
 *
 * @param {string} path - module 路径。
 * @returns {string} 转义后的路径。
 */
export function escapeGoModulePath(path) {
  let out = '';
  for (const ch of String(path)) {
    if (ch === '!') out += '!!';
    else if (ch >= 'A' && ch <= 'Z') out += `!${ch.toLowerCase()}`;
    else out += ch;
  }
  return out;
}

/**
 * 按 registry 的规矩把包名归一化。
 *
 * npm 的 scoped 包保留 `@scope/name` 两段；pypi 把下划线换成分隔符并小写；
 * cargo 认为下划线和连字符等价（源码里是 Rust，包名是连字符）。
 *
 * @param {string} name - 原始名字。
 * @param {string} registry - registry 名。
 * @returns {string} 归一化后的名字。
 */
export function normaliseName(name, registry) {
  const raw = String(name ?? '').trim();
  if (registry === 'pypi') return raw.toLowerCase().replace(/_/gu, '-');
  if (registry === 'cargo') return raw.toLowerCase().replace(/_/gu, '-');
  return raw;
}
