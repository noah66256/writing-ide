import NavBar from "../components/NavBar.tsx";

export default function LandingPage() {
  return (
    <>
      <NavBar />

      {/* ── HERO ── */}
      <section
        className="pt-32 pb-20 relative overflow-hidden"
        style={{ background: "linear-gradient(180deg, #FFF5EE 0%, #FFFDF9 60%)" }}
      >
        {/* Glow */}
        <div
          className="absolute pointer-events-none"
          style={{
            top: -60, left: "50%", transform: "translateX(-50%)",
            width: 1100, height: 700,
            background: "radial-gradient(ellipse at center, rgba(232,74,10,0.13) 0%, rgba(245,166,35,0.06) 40%, transparent 70%)",
          }}
        />

        <div className="max-w-5xl mx-auto px-6 text-center relative">
          <div className="flex justify-center mb-6">
            <span className="chip">
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
              v0.2 · 支持 MCP 工具生态 · macOS & Windows
            </span>
          </div>

          <h1 className="text-5xl md:text-6xl font-bold tracking-tight leading-[1.15] mb-6">
            你的 <span className="brand-text">AI 团队</span>
            <br />随时待命，无限可能
          </h1>

          <p className="text-xl text-gray-500 max-w-2xl mx-auto mb-10 leading-relaxed">
            对话驱动的桌面 AI 智能体，集写作、调研、知识库管理于一体——
            <br className="hidden md:block" />
            切换助手模式，直接接管你的电脑，帮你干完所有事。
          </p>

          <div className="flex flex-wrap justify-center gap-3 mb-14">
            <a href="#download" className="btn-brand">
              <i className="fa fa-apple" /> macOS M 系列
            </a>
            <a href="#download" className="btn-outline">
              <i className="fa fa-apple" /> macOS Intel
            </a>
            <a href="#download" className="btn-outline">
              <i className="fa fa-windows" /> Windows
            </a>
          </div>

          {/* App screenshot */}
          <div className="window-mock max-w-4xl mx-auto">
            <div className="window-titlebar">
              <span className="traffic-light bg-red-400" />
              <span className="traffic-light bg-yellow-400" />
              <span className="traffic-light bg-green-400" />
              <span className="text-xs text-gray-400 ml-3">Oh My Crab · Friday</span>
            </div>
            <img src="/screenshot.png" alt="Oh My Crab 界面" className="block w-full" />
          </div>

          {/* Stats */}
          <div className="flex flex-wrap justify-center gap-10 mt-12 text-center">
            {[
              { val: "48+", label: "内置工具" },
              { val: "3", label: "内置 MCP Server" },
              { val: "100%", label: "本地数据，绝不外传" },
              { val: "∞", label: "可扩展 Skill" },
            ].map(({ val, label }) => (
              <div key={label}>
                <div className="text-3xl font-bold brand-text">{val}</div>
                <div className="text-sm text-gray-400 mt-1">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="section-divider max-w-5xl" />

      {/* ── MODES ── */}
      <section
        id="modes"
        className="py-24"
        style={{ background: "linear-gradient(180deg, #fff6ee 0%, #fffdf9 100%)" }}
      >
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-14">
            <div className="flex justify-center mb-4">
              <span className="chip"><i className="fa fa-sliders" /> 双模式设计</span>
            </div>
            <h2 className="text-4xl font-bold mb-4">创作 vs 助手，两种工作方式</h2>
            <p className="text-gray-500 text-lg">根据任务随时切换，一个软件搞定所有场景</p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {/* Creative */}
            <div className="feature-card">
              <div className="flex items-center gap-3 mb-5">
                <div className="feature-icon"><i className="fa fa-pencil" /></div>
                <div>
                  <span className="mode-creative">创作模式</span>
                  <div className="text-xs text-gray-400 mt-1">写作 · 改稿 · 风格仿写</div>
                </div>
              </div>
              <p className="text-gray-600 text-sm leading-relaxed mb-4">
                专注内容生产的安全模式。AI 调用写作、知识库、风格仿写工具，从选题到成稿全程陪跑。
              </p>
              <div className="space-y-2 text-sm">
                {[
                  { icon: "fa-book", text: "知识库检索 — 学过的资料随时引用" },
                  { icon: "fa-magic", text: "风格深度克隆 — 学习目标风格，输出高度一致" },
                  { icon: "fa-check-circle", text: "质量自检 — 重合度 + 风格对齐双重 lint" },
                ].map(({ icon, text }) => (
                  <div key={text} className="highlight-bar flex items-center gap-3">
                    <i className={`fa ${icon}`} style={{ color: "#E84A0A" }} />
                    <span className="text-gray-700">{text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Assistant */}
            <div className="feature-card" style={{ borderColor: "#1a1a1a" }}>
              <div className="flex items-center gap-3 mb-5">
                <div className="feature-icon" style={{ background: "#1a1a1a" }}>
                  <i className="fa fa-terminal" />
                </div>
                <div>
                  <span className="mode-assistant">助手模式</span>
                  <div className="text-xs text-gray-400 mt-1">全量接管 · 超级权限</div>
                </div>
              </div>
              <p className="text-gray-600 text-sm leading-relaxed mb-4">
                释放全部能力。AI 可以操控浏览器、执行系统命令、管理进程、创建定时任务——真正的「数字员工」。
              </p>
              <div className="space-y-2 text-sm font-mono">
                {[
                  { icon: "fa-terminal", text: "Bash · 执行系统命令" },
                  { icon: "fa-globe", text: "Playwright · 接管浏览器（69 个工具）" },
                  { icon: "fa-clock-o", text: "Cron · 创建定时任务，自动运行" },
                ].map(({ icon, text }) => (
                  <div key={text} className="bg-gray-900 text-green-400 rounded-lg px-4 py-2 text-xs flex items-center gap-2">
                    <i className={`fa ${icon}`} /> {text}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="section-divider max-w-5xl" />

      {/* ── FEATURES ── */}
      <section id="features" className="py-24">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-16">
            <div className="flex justify-center mb-4">
              <span className="chip"><i className="fa fa-star" /> 核心能力</span>
            </div>
            <h2 className="text-4xl font-bold mb-4">不止是 AI 聊天</h2>
            <p className="text-gray-500 text-lg max-w-xl mx-auto">内置 48 个工具、3 个 MCP Server，AI 真正帮你干活。</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-5">
            {[
              { icon: "fa-comments", title: "对话即指令", desc: "用自然语言描述任务，AI 智能调用工具、查询知识库、分步执行。支持文字、图片、文件、语音多种输入。" },
              { icon: "fa-book", title: "本地知识库", desc: "向量化检索，导入文章、资料、语料，AI 自动引用。数据 100% 存本地，企业保密资料安心使用。" },
              { icon: "fa-clone", title: "风格深度克隆", desc: "导入你喜欢的文章、演讲、公号文，AI 学习词汇、句式、节奏——每次输出都像出自同一人之手。" },
            ].map(({ icon, title, desc }) => (
              <div key={title} className="feature-card">
                <div className="feature-icon"><i className={`fa ${icon}`} /></div>
                <h3 className="font-bold text-lg mb-2">{title}</h3>
                <p className="text-gray-500 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="feature-card flex gap-5">
              <div className="feature-icon flex-shrink-0"><i className="fa fa-puzzle-piece" /></div>
              <div>
                <h3 className="font-bold text-lg mb-2">MCP 工具生态</h3>
                <p className="text-gray-500 text-sm leading-relaxed mb-3">
                  支持 Model Context Protocol，内置 Playwright 浏览器（69 工具）、博查搜索、联网抓取。可无限扩展第三方 MCP Server。
                </p>
                <div className="flex flex-wrap gap-2">
                  {["Playwright 浏览器", "联网搜索", "图片生成", "代码执行"].map((t) => (
                    <span key={t} className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full">{t}</span>
                  ))}
                </div>
              </div>
            </div>
            <div className="feature-card flex gap-5">
              <div className="feature-icon flex-shrink-0"><i className="fa fa-search" /></div>
              <div>
                <h3 className="font-bold text-lg mb-2">调研模式</h3>
                <p className="text-gray-500 text-sm leading-relaxed mb-3">
                  全网搜索、热点追踪、网页抓取、多源汇总——AI 做你的信息助理，从原始素材到结构化报告一键完成。
                </p>
                <div className="flex items-center gap-4 text-xs text-gray-400">
                  <span><i className="fa fa-check-circle mr-1" style={{ color: "#E84A0A" }} />支持多轮深挖</span>
                  <span><i className="fa fa-check-circle mr-1" style={{ color: "#E84A0A" }} />自动引用来源</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="section-divider max-w-5xl" />

      {/* ── HOW IT WORKS ── */}
      <section id="how" className="py-24" style={{ background: "#FFF9F5" }}>
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-16">
            <div className="flex justify-center mb-4">
              <span className="chip"><i className="fa fa-bolt" /> 工作流程</span>
            </div>
            <h2 className="text-4xl font-bold mb-4">三步完成任何任务</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                n: "1", title: "选择模式，描述任务",
                desc: "创作模式写文章，调研模式查资料，助手模式让 AI 直接操作电脑。用一句话说出你想要什么。",
                example: '"用创作模式，参考乔布斯风格，帮我写一篇产品发布演讲稿"',
              },
              {
                n: "2", title: "AI 自主规划执行",
                desc: "AI 自动决策：查知识库、调用风格 Skill、搜索补充信息——你不需要知道背后跑了什么。",
                example: null,
              },
              {
                n: "3", title: "对话式迭代完善",
                desc: "拿到初稿后，继续对话微调。AI 记住上下文，每次改动精准响应，直到你满意为止。",
                example: null,
              },
            ].map(({ n, title, desc, example }) => (
              <div key={n} className="flex flex-col items-start">
                <div className="step-num mb-5">{n}</div>
                <h3 className="font-bold text-lg mb-3">{title}</h3>
                <p className="text-gray-500 text-sm leading-relaxed">{desc}</p>
                {example && (
                  <div className="mt-4 bg-white border border-gray-200 rounded-xl p-4 w-full text-sm text-gray-600">
                    {example}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="section-divider max-w-5xl" />

      {/* ── TESTIMONIALS ── */}
      <section className="py-24">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-14">
            <h2 className="text-4xl font-bold mb-4">用户怎么说</h2>
            <p className="text-gray-500">来自内测用户的真实反馈</p>
          </div>
          <div className="grid md:grid-cols-3 gap-5">
            {[
              { name: "张老师", sub: "独立创作者 · 20万粉丝", color: "from-brand to-brand-light", text: "风格克隆功能太绝了，把我自己3年的公众号文章喂进去，AI写的东西我完全认不出来哪段是AI的。" },
              { name: "李总监", sub: "市场营销 · 某互联网公司", color: "from-purple-500 to-purple-400", text: "助手模式直接让AI帮我操控浏览器搜资料、整理表格、发邮件，我只需要看最终结果，效率翻了五倍。" },
              { name: "王总", sub: "CEO · 某咨询公司", color: "from-emerald-600 to-emerald-400", text: "本地知识库是最吸引我的，公司保密资料不用担心泄露。现在整个内容生产流程都搬进来了。" },
            ].map(({ name, sub, color, text }) => (
              <div key={name} className="quote-card">
                <div className="flex gap-1 mb-4" style={{ color: "#E84A0A" }}>
                  {"★★★★★".split("").map((s, i) => <span key={i}>{s}</span>)}
                </div>
                <p className="text-sm text-gray-700 leading-relaxed mb-5">"{text}"</p>
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold bg-gradient-to-br ${color}`}>
                    {name[0]}
                  </div>
                  <div>
                    <div className="text-sm font-medium">{name}</div>
                    <div className="text-xs text-gray-400">{sub}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="section-divider max-w-5xl" />

      {/* ── PRICING ── */}
      <section id="pricing" className="py-24" style={{ background: "linear-gradient(180deg, #fff6ee 0%, #fffdf9 100%)" }}>
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-14">
            <div className="flex justify-center mb-4">
              <span className="chip"><i className="fa fa-tag" /> 定价</span>
            </div>
            <h2 className="text-4xl font-bold mb-4">简单直接的定价</h2>
            <p className="text-gray-500">自带大模型 API Key，按量付费，无订阅套路</p>
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            {/* Free */}
            <div className="pricing-card">
              <div className="text-sm font-semibold text-gray-500 mb-2">免费版</div>
              <div className="text-3xl font-bold mb-1">¥0</div>
              <div className="text-sm text-gray-400 mb-6">永久免费</div>
              <ul className="space-y-3 text-sm text-gray-600 mb-8">
                {["基础对话 + 创作模式", "本地知识库（500条）", "内置 MCP Server"].map((f) => (
                  <li key={f} className="flex items-center gap-2"><i className="fa fa-check" style={{ color: "#E84A0A" }} /> {f}</li>
                ))}
                {["助手模式（全量接管）", "风格深度克隆"].map((f) => (
                  <li key={f} className="flex items-center gap-2 text-gray-300"><i className="fa fa-times" /> {f}</li>
                ))}
              </ul>
              <a href="#download" className="btn-outline w-full justify-center">开始使用</a>
            </div>

            {/* Pro */}
            <div className="pricing-card featured">
              <div className="pricing-badge">最受欢迎</div>
              <div className="text-sm font-semibold mb-2" style={{ color: "#E84A0A" }}>专业版</div>
              <div className="text-3xl font-bold mb-1">¥99<span className="text-base font-normal text-gray-400">/月</span></div>
              <div className="text-sm text-gray-400 mb-6">或 ¥799/年（省¥389）</div>
              <ul className="space-y-3 text-sm text-gray-600 mb-8">
                {["免费版全部功能", "助手模式（电脑全量接管）", "风格深度克隆（无限语料）", "知识库无限容量", "Skill 扩展生态"].map((f) => (
                  <li key={f} className="flex items-center gap-2"><i className="fa fa-check" style={{ color: "#E84A0A" }} /> {f}</li>
                ))}
              </ul>
              <a href="/login" className="btn-brand w-full justify-center">立即升级</a>
            </div>

            {/* Team */}
            <div className="pricing-card">
              <div className="text-sm font-semibold text-gray-500 mb-2">团队版</div>
              <div className="text-3xl font-bold mb-1">定制</div>
              <div className="text-sm text-gray-400 mb-6">联系我们</div>
              <ul className="space-y-3 text-sm text-gray-600 mb-8">
                {["专业版全部功能", "团队共享知识库", "统一 API Key 管理", "私有化部署", "专属技术支持"].map((f) => (
                  <li key={f} className="flex items-center gap-2"><i className="fa fa-check" style={{ color: "#E84A0A" }} /> {f}</li>
                ))}
              </ul>
              <a href="mailto:hello@ohmycrab.top" className="btn-outline w-full justify-center">联系我们</a>
            </div>
          </div>
          <p className="text-center text-sm text-gray-400 mt-8">
            <i className="fa fa-lock mr-1" /> 自带大模型 Key，所有请求直连模型提供商，费用完全可控
          </p>
        </div>
      </section>

      {/* ── DOWNLOAD ── */}
      <section id="download" className="py-24">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <img src="/icon.png" className="w-16 h-16 rounded-2xl mx-auto mb-8" alt="logo" />
          <h2 className="text-4xl font-bold mb-4">准备好了吗？</h2>
          <p className="text-gray-500 text-lg mb-10">免费下载，3分钟上手，数据全在本地。</p>
          <div className="flex flex-wrap justify-center gap-4">
            <a href="http://ohmycrab.top/downloads/desktop/stable/OhMyCrab-0.2.0-arm64.dmg" className="btn-brand text-base py-3.5 px-7">
              <i className="fa fa-apple text-lg" /> macOS M 系列
              <span className="text-xs opacity-75 ml-1">M1 / M2 / M3 / M4</span>
            </a>
            <a href="http://ohmycrab.top/downloads/desktop/stable/OhMyCrab-0.2.0-x64.pkg" className="btn-outline text-base py-3.5 px-7">
              <i className="fa fa-apple text-lg" /> macOS Intel
              <span className="text-xs text-gray-400 ml-1">PKG 安装包</span>
            </a>
            <a href="http://ohmycrab.top/downloads/desktop/stable/Oh.My.Crab.Setup.0.2.0.exe" className="btn-outline text-base py-3.5 px-7">
              <i className="fa fa-windows text-lg" /> Windows
              <span className="text-xs text-gray-400 ml-1">安装版</span>
            </a>
          </div>
          <div className="flex items-center justify-center gap-8 mt-10 text-sm text-gray-400">
            <span><i className="fa fa-lock mr-1.5" />数据本地存储</span>
            <span><i className="fa fa-shield mr-1.5" />安全可控</span>
            <span><i className="fa fa-refresh mr-1.5" />自动更新</span>
            <span><i className="fa fa-puzzle-piece mr-1.5" />无限扩展</span>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="py-12" style={{ borderTop: "1px solid rgba(232,74,10,0.12)", background: "#FFF9F5" }}>
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex flex-col md:flex-row items-start justify-between gap-8">
            <div>
              <div className="flex items-center gap-2 font-bold text-[16px] text-gray-900 mb-3">
                <img src="/icon.png" className="w-7 h-7 rounded-lg" alt="logo" />
                Oh My Crab
              </div>
              <p className="text-sm text-gray-400 max-w-xs">对话驱动的桌面 AI 团队平台，让每个人都拥有自己的智能助理团队。</p>
            </div>
            <div className="flex gap-12 text-sm">
              <div>
                <div className="font-semibold text-gray-700 mb-3">产品</div>
                <div className="space-y-2 text-gray-400">
                  <div><a href="#features" className="hover:text-gray-700 no-underline">功能介绍</a></div>
                  <div><a href="#modes" className="hover:text-gray-700 no-underline">双模式</a></div>
                  <div><a href="#pricing" className="hover:text-gray-700 no-underline">定价</a></div>
                  <div><a href="#download" className="hover:text-gray-700 no-underline">下载</a></div>
                </div>
              </div>
              <div>
                <div className="font-semibold text-gray-700 mb-3">支持</div>
                <div className="space-y-2 text-gray-400">
                  <div><a href="#" className="hover:text-gray-700 no-underline">使用文档</a></div>
                  <div><a href="#" className="hover:text-gray-700 no-underline">常见问题</a></div>
                  <div><a href="mailto:hello@ohmycrab.top" className="hover:text-gray-700 no-underline">联系我们</a></div>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-10 pt-6 flex flex-col md:flex-row items-center justify-between text-xs text-gray-400 gap-3" style={{ borderTop: "1px solid #F0EDE8" }}>
            <div>© 2025 Oh My Crab. 保留所有权利。</div>
            <div className="flex gap-4">
              <a href="#" className="hover:text-gray-600 no-underline">隐私政策</a>
              <a href="#" className="hover:text-gray-600 no-underline">服务条款</a>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}
