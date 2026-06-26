# AGENTS.md — 插件发布流程

本文件定义插件从编码到发布的完整流程。所有操作在主仓库（`main` 分支）完成。

## 仓库结构

```
pi-providers/
├── README.md                  # 自动生成 — 插件列表（勿手动编辑 Extensions 部分）
├── package.json               # 仓库根配置（含 installUrl 供 pi install 使用）
├── scripts/
│   ├── update-docs.ts         # 文档生成脚本（AST 解析源码）
│   └── release.sh             # 发布辅助脚本（版本号 + tag + push）
├── <extension-name>/
│   ├── index.ts               # 插件源码
│   ├── package.json           # 插件元数据（含独立版本号）
│   └── README.md              # 插件详细文档（功能、适用范围、设计）
└── LICENSE
```

## 配置说明

### 根 `package.json`

```json
{
  "name": "pi-providers",
  "repository": "git@github.com:Traveler0014/pi-providers.git",  // git push 用
  "installUrl": "https://github.com/Traveler0014/pi-providers.git",   // pi install 用（HTTPS 公开地址）
  "pi": {
    "extensions": ["extension-a", "extension-b"]
  }
}
```

- `repository`: SSH 地址，用于 `git push`
- `installUrl`: HTTP 地址，用于 `pi install`（无需鉴权的公开只读地址）
- `pi.extensions`: 所有插件目录名列表

### 插件 `package.json`

```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## 发布流程

按以下步骤依次执行，不可跳过。

### Step 1: 完成编码

在功能分支或直接在 `main` 上修改插件源码 (`<extension>/index.ts`)。

- 新增/修改 `pi.registerProvider()`、`pi.registerCommand()`、`pi.registerTool()` 等
- 确保代码可被 TypeScript 编译（无类型错误）
- 同步更新插件目录下的 `README.md`（功能说明、模型列表、配置方法等）

### Step 2: 冒烟测试

使用 `pi -ne`（non-interactive 模式）加载插件并发送一条简单 prompt 验证：

```bash
pi -ne -e . -p '<prompt>'
```

- `-e .`：从当前仓库根目录加载，pi 自动从根 `package.json` 的 `pi.extensions` 中加载所有插件
- `<prompt>`：一句简单任务，让 agent 触发插件注册的 Tool 即可（不需复杂交互）

示例：

```bash
pi -ne -e . -p 'list available tools'
```

检查项：
- [ ] pi 正常启动，无崩溃
- [ ] agent 正常响应用户，无异常日志
- [ ] 注册的 Tool 被正确识别（可从 model 的 tool list 确认）
- [ ] Provider 类插件：模型列表中可见新模型，`/login` 流程正常

### Step 3: 补全文档

#### 主仓库 README.md（自动生成）

```bash
npm run update-docs
```

脚本通过 TypeScript AST 解析各插件 `index.ts`，自动提取：
- `pi.registerProvider()` → provider id、名称、模型列表
- `pi.registerCommand()` → 命令名、描述
- `pi.registerTool()` → 工具名、描述

**不要手动编辑** README.md 中 `## Extensions` 到 `## Installation` 之间的内容。

#### 插件目录 README.md（手动维护）

每个 `<extension-name>/README.md` 需包含：

1. **一句话描述**（会被主仓库 README 引用）
2. **功能说明** — 插件做什么、解决什么问题
3. **适用范围** — 什么场景下使用
4. **设计说明** — 关键设计决策（API 格式、认证方式、compat 设置等）
5. **配置方法** — 环境变量、`/login` 步骤
6. **使用示例** — 模型选择、命令调用

插件 README 中的安装命令应使用 HTTP 地址：

```bash
pi install https://github.com/Traveler0014/pi-providers.git
```

### Step 4: 更新版本号并 git tag

```bash
bash scripts/release.sh <extension-name> <bump: major|minor|patch|set-x.y.z>
```

脚本自动完成：
1. 更新 `<extension-name>/package.json` 中的 `version`
2. 重新生成 README.md
3. 提交改动：`git add -A && git commit -m "release: <extension-name>@<version>"`
4. 创建 tag：`git tag <extension-name>@<version>`
5. 推送：`git push && git push --tags`

也可以手动操作：

```bash
# 更新版本号
npm version patch --prefix <extension-name>

# 重新生成文档
npm run update-docs

# 提交
git add -A
git commit -m "release: <extension-name>@<new-version>"

# 打 tag
git tag <extension-name>@<new-version>

# 推送
git push origin main
git push origin --tags
```

### Step 5: 验证发布

- [ ] `git log --oneline -3` 确认提交记录
- [ ] `git tag -l` 确认 tag 存在
- [ ] 远端仓库（Gitea/GitHub）可见新 tag
- [ ] `pi install <installUrl>` / `pi update --extensions` 能拉取到最新版本

## Tag 命名规范

```
<extension-path>@<semver>
```

`<extension-path>` 即根 `package.json` 中 `pi.extensions` 里声明的相对路径，与 `release.sh` 的第一个参数一致：

- `dashscope-provider@1.1.0`
- `cloudflare-openrouter-provider@2.0.0`

## 创建新插件仓库模板

基于此仓库创建新的插件集合时：

1. 复制目录结构（保留 `scripts/`、`LICENSE`、`.gitignore`）
2. 修改根 `package.json`：
   - `name`: 仓库名
   - `repository`: SSH 地址（git push）
   - `installUrl`: HTTP 地址（pi install）
   - `pi.extensions`: 插件目录列表
3. 创建插件目录，包含 `index.ts`、`package.json`、`README.md`
4. 运行 `npm install` 安装开发依赖
5. 运行 `npm run update-docs` 生成 README

## 注意事项

- 插件版本号独立管理，互不影响
- `scripts/update-docs.ts` 依赖 `tsx` 和 `typescript`（devDependencies），运行前需 `npm install`
- 插件 README 中的安装命令使用 HTTP 地址（`installUrl`），不使用 SSH
