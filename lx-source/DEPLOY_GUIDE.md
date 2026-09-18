# LX-Source 部署与维护指南

## 一、项目结构

```
lx-source/
├── custom-source.js    # 主脚本（洛雪音乐客户端加载此文件）
├── rules.json          # 远程配置规则（可云端热更新）
└── DEPLOY_GUIDE.md     # 本指南
```

## 二、部署步骤

### 1. 创建 GitHub 仓库

```bash
# 创建仓库（假设仓库名为 lx-source）
gh repo create lx-source --public
# 或在 GitHub 网页手动创建
```

### 2. 上传文件

```bash
cd lx-source
git init
git add custom-source.js rules.json
git commit -m "init: LX-Source v1.0.0"
git remote add origin https://github.com/YOUR_USERNAME/lx-source.git
git push -u origin main
```

### 3. 修改配置中的仓库地址

编辑 `custom-source.js`，将第 12 行的 `RULES_URL` 替换为你的实际地址：

```javascript
var RULES_URL = 'https://raw.githubusercontent.com/YOUR_USERNAME/lx-source/main/rules.json'
```

同样编辑 `rules.json`，修改 `configUrl` 字段。

### 4. 导入到洛雪音乐客户端

#### 方式一：通过 URL 导入（推荐）

使用 GitHub 加速链接直接导入脚本：

```
https://ghfast.top/https://raw.githubusercontent.com/YOUR_USERNAME/lx-source/main/custom-source.js
```

在洛雪音乐客户端中：
1. 打开 **设置** → **自定义源**
2. 点击 **导入脚本**
3. 粘贴上述加速链接
4. 确认导入

#### 方式二：本地文件导入

1. 下载 `custom-source.js` 到本地
2. 在洛雪音乐客户端中导入该文件

## 三、配置上游音源

编辑 `rules.json` 中的 `upstreams` 字段，添加实际可用的上游 API：

```json
{
  "upstreams": {
    "kw": [
      {
        "name": "kw-main",
        "url": "https://your-api.com/kw/url",
        "priority": 1,
        "enabled": true
      }
    ],
    "kg": [...],
    "tx": [...],
    "wy": [...],
    "mg": [...]
  }
}
```

每个上游 API 需要：
- 接收 GET 请求参数：`songmid`, `songId`, `quality`, `source`, `name`, `singer`, `album`
- 直接返回音频 URL 字符串，或返回 JSON 对象 `{ "url": "https://..." }`

## 四、远程热更新

1. 修改 `rules.json` 并推送到 GitHub
2. 所有用户的客户端在下次播放时会自动拉取最新配置
3. 如果拉取失败，自动回退到本地缓存的配置，不影响使用

## 五、假音频过滤规则

在 `rules.json` 的 `fakeAudioFilter` 中配置：

```json
{
  "fakeAudioFilter": {
    "enabled": true,
    "maxFileSize": 1572864,
    "minValidSize": 1048576,
    "blacklistDomains": ["ad.example.com"],
    "blacklistMd5": ["d41d8cd98f00b204e9800998ecf8427e"],
    "fakeAudioPatterns": ["请到.*收听", "版权.*限制"],
    "errorCodes": [403, 404, 410, 451]
  }
}
```

- `maxFileSize`: 超过此大小的文件视为正常（字节）
- `minValidSize`: 小于此大小的文件视为假音频（字节）
- `blacklistDomains`: 已知引流域名黑名单
- `blacklistMd5`: 已知假音频的 MD5 哈希值
- `fakeAudioPatterns`: 引流提示音中的文本特征正则
- `errorCodes`: 直接判定为无效的 HTTP 状态码

## 六、维护说明

### 添加新上游

1. 在 `rules.json` 的 `upstreams` 中对应平台数组添加新条目
2. 设置 `priority`（数字越小优先级越高）
3. 推送到 GitHub，所有用户自动生效

### 禁用某个上游

将对应条目的 `enabled` 设为 `false`，推送即可。

### 更换加速镜像

修改 `rules.json` 的 `mirrors.github` 数组，按优先级排列可用镜像。

## 七、常见问题

### Q: 导入后提示加载失败？

A: 检查加速链接是否可用，尝试切换其他镜像前缀。

### Q: 播放时没有声音？

A: 检查 `rules.json` 中对应平台的上游 API 是否配置正确且可用。

### Q: 假音频未被拦截？

A: 更新 `fakeAudioFilter` 中的 `fakeAudioPatterns` 添加新的引流文案特征。
