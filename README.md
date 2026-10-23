# 模型状态

汇总 New API 站点公开模型统计。用户可自行添加、编辑和移除站点，列表保存在各自的浏览器中，无需注册、API Key 或数据库。

支持模型搜索、系列和状态筛选、1 / 6 / 24 小时统计、历史状态条、请求成功率、耗时、输出速度和分组统计。默认每 30 秒刷新，页面隐藏时暂停；只读取公开统计，不主动调用模型。

## VPS 部署

需要已安装 Docker 和 Docker Compose：

```sh
git clone https://github.com/L1ke40oz/model-observatory.git
cd model-observatory
docker compose up -d --build
```

检查运行状态：

```sh
docker compose ps
docker compose logs --tail=50
curl http://127.0.0.1:8787/api/health
```

健康接口正常时返回 `{"ok":true}`。默认只向 VPS 本机开放 `127.0.0.1:8787`，在现有反向代理面板中将域名指向此地址，并开启 HTTPS。不需要把 8787 端口开放到公网。

使用宿主机上的 Nginx 时，可参考以下配置，替换域名后按现有方式配置 TLS：

```nginx
server {
    listen 80;
    server_name status.example.com;
    client_max_body_size 4k;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 30s;
    }
}
```

如果反向代理也在容器里，代理容器中的 `127.0.0.1` 指向它自身，需要将两个容器加入同一 Docker 网络并使用服务名连接。

更新版本：

```sh
cd model-observatory
git pull --ff-only
docker compose up -d --build
```

源码更新和容器重建不会删除浏览器中的列表。浏览器保存的数据按访问域名、协议和端口区分，更换网址前请先导出配置。

## 本地运行

需要 Node.js 22+，无需 npm install：

```sh
npm start
```

打开 <http://127.0.0.1:8787>。环境变量 `HOST`、`PORT` 可修改监听地址和端口，默认仅监听本机。

## 使用与兼容性

点击“管理站点”，填写名称和 HTTPS 地址。例如 `https://api.example.com`；粘贴 `/pricing` 或 `/v1` 地址时会提取域名。最多保存 30 个站点，不接受带账号、密码、查询参数或非默认端口的地址。

目前适配 `/api/pricing`、`/api/perf-metrics/summary`、`/api/perf-metrics`。要求登录或使用其他接口的站点会提示读取失败，不保证兼容所有 New API 分支。

列表保存于当前浏览器的 localStorage。清除网站数据、换浏览器或换设备时不会自动同步；可提前导出 JSON 文件备份，再在新设备导入。导入按地址合并，同地址使用导入文件中的名称。删除全部站点后保持空列表，刷新不会重新加入默认示例。

部署者可在 `sites.json` 设置默认公开示例；仅用于尚未保存本机列表的浏览器。不要把私人地址提交到这个公开文件或 GitHub。

## 隐私和资源

- 无账号、无数据库，也没有上传或列出用户私人站点列表的服务端接口。
- 查询时，当前站点地址会通过请求体发送给 VPS，由它获取公开统计。VPS 运营者仍可能接触地址；本机保存不代表匿名查询。
- 服务器不会主动将私人列表或统计写入磁盘；短期内存缓存会被访客复用，不存在浏览器端的全局私人站点目录。
- 共用同一浏览器配置的人可能看到同一列表。导出文件也是包含地址的普通 JSON，请自行保管。
- 缓存序列化数据最多 16 MiB、256 项，空闲条目 10 分钟后清理。Node.js 对象和运行时的实际内存会大于此值。
- 最多同时执行 12 个上游读取，每个响应最多 4 MiB、超时 15 秒。容器默认内存上限 256 MiB；没有访客查看时不后台轮询。
- 自定义站点仅支持公网 HTTPS 域名。每次新请求检查全部 DNS 结果、固定实际连接 IP、验证 TLS 证书，并拒绝重定向、内网、回环和保留地址。

程序没有访问登录控制。大规模公共使用时，可在现有反向代理上配置请求限速。

## 数据含义

- 模型系列下方可选择分组；全部分组使用站点汇总，指定分组使用该分组的成功率、历史记录、耗时和速度。分组详情仅在模型进入可见区域及附近时读取，最多同时读取 4 个，避免一次请求全部模型。
- 部分旧版汇总只返回 `recent_success_rates`，没有记录时间。页面展示其实际返回的近期成功率并注明“未提供时间”，不补造完整的 24 小时时间轴。选定分组后，如果详情接口提供带时间的记录，则显示对应的真实时间轴。
- 右上角时钟显示当前 UTC+8 时间，每秒更新，与统计获取和模型调用时间分开。悬停时钟前的状态点可查看统计获取时间。
- 当前汇总接口将历史序列合并到整点小时：18:00 表示从 18 点开始的统计时段，有该时段请求数据后才会出现新时段。
- 请求成功率、耗时和速度是所选时段的汇总。
- 近期状态根据最近统计时段分类：≥95% 为近期正常，0% 为近期失败，其余为成功率偏低。分类阈值由本页面设定，并非上游直接提供的健康状态。
- 最近统计时段的开始时间距现在满 2 小时：仅历史数据；没有记录：暂无数据。两者均不代表模型当前不可调用。
- 统计时段显示的是开始时间，不是最后请求时间。首 Token 耗时为 0 或未测得时，不当作有效的零延迟。
- 色条保留无记录区间，不补成功记录；同一显示格内有多条数据时展示最新统计，不作加权推断。
- 同步失败保留最近成功结果并标明中断；服务器最多保留 10 分钟内的旧结果。暂停刷新后页面仍会将过期状态改为“仅历史数据”。

页面定时获取统计，不提供“此刻一定能调用”的主动探测结论。

## 检查代码

```sh
npm run check
npm test
```

测试覆盖状态判断、站点与配置校验、私网和 DNS 地址检查、服务端接口限制。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `public/index.html` | 页面结构与固定文案 |
| `public/styles.css` | 样式和手机适配 |
| `public/app.js` | 数据展示、筛选与详情 |
| `public/site-manager.js` | 站点管理与浏览器保存 |
| `public/site-config.js` | 站点与导入格式校验 |
| `public/model-state.js` | 状态分类 |
| `server.mjs` | 统计代读与缓存 |
| `lib/public-request.mjs` | 公网 DNS 校验与固定连接 |

## 开源参考

本项目独立实现，未复制以下项目代码。查阅日期：2026-10-23。

- [QuantumNous/new-api](https://github.com/QuantumNous/new-api)：对照 v1.0.0-rc.36 的公开性能统计接口。
- [LFMJUN/newapi-status-embed](https://github.com/LFMJUN/newapi-status-embed)：从管理日志聚合统计，需要管理员 Token。
- [yigehaozi/relay-status-monitor](https://github.com/yigehaozi/relay-status-monitor)：多中转站面板，包含模型测速。
