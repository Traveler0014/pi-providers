# pi-extensions

Collection of extensions for [pi](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
|-----------|-------------|
| [dashscope-provider](./dashscope-provider) | Alibaba Cloud DashScope (阿里云百炼) provider — Qwen3.7 Max/Plus |

## Installation

### Option 1: pi install (recommended)

```bash
pi install git@github.com:Traveler0014/pi-providers.git
```

This clones the repo and auto-loads all extensions. Update with:

```bash
pi update --extensions
```

### Option 2: One-click install script

```bash
curl -fsSL https://github.com/Traveler0014/pi-providers.git/raw/master/install.sh | bash
```

Or clone and run locally:

```bash
git clone git@github.com:Traveler0014/pi-providers.git.git /tmp/pi-extensions
bash /tmp/pi-extensions/install.sh
```

### Option 3: Manual copy

```bash
# Copy specific extension
cp dashscope-provider/index.ts ~/.pi/agent/extensions/dashscope-provider.ts
```

### Option 4: Try without installing

```bash
pi -e git@github.com:Traveler0014/pi-providers.git
```

## License

MIT
