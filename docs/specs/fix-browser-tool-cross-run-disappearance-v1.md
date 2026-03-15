{\rtf1\ansi\ansicpg936\cocoartf2867
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fnil\fcharset0 Menlo-Regular;\f1\fnil\fcharset0 Menlo-Bold;\f2\fnil\fcharset0 Menlo-Italic;
\f3\fnil\fcharset0 Menlo-BoldItalic;}
{\colortbl;\red255\green255\blue255;\red0\green0\blue0;\red69\green77\blue245;\red86\green32\blue244;
\red57\green192\blue38;\red202\green51\blue35;\red170\green171\blue37;\red56\green185\blue199;}
{\*\expandedcolortbl;;\csgray\c0;\cssrgb\c34118\c41176\c96863;\cssrgb\c41681\c25958\c96648;
\cssrgb\c25706\c77963\c19557;\cssrgb\c83899\c28663\c18026;\cssrgb\c72331\c71682\c18599;\cssrgb\c25546\c77007\c82023;}
\paperw11900\paperh16840\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx560\tx1120\tx1680\tx2240\tx2800\tx3360\tx3920\tx4480\tx5040\tx5600\tx6160\tx6720\pardirnatural\partightenfactor0

\f0\fs22 \cf2 \CocoaLigature0 ---                        \
  # Fix: \uc0\u36328  Run \u27983 \u35272 \u22120 \u24037 \u20855 \u28040 \u22833 \u65288 Browser Tool Cross-Run Disappearance\u65289                                                                                                                                          \
                                                                                                                                                                                                             \
  > spec v1 \'b7 2026-03-16                                                                                                                                                                                       \
                                                                                                                                                                                                               \
  ## \uc0\u19968 \u12289 \u29616 \u35937 \
\
  \uc0\u29992 \u25143 \u20351 \u29992  Playwright MCP \u25191 \u34892  ICP \u22791 \u26696 \u65288 \u38463 \u37324 \u20113 \u25511 \u21046 \u21488 \u22810 \u27493 \u34920 \u21333 \u22635 \u20889 \u65289 \u12290 Agent \u22312 \u31532 \u19968 \u20010  Run \u20013 \u27491 \u24120 \u20351 \u29992 \u20840 \u37096  Playwright \u24037 \u20855 \u65288 navigate\u12289 click\u12289 fill\u12289 type\u12289 snapshot \u31561 \u65289 \u12290 \
\
  \uc0\u24403  Run \u32467 \u26463 \u21518 \u65292 \u29992 \u25143 \u21457 \u36865 
\f1\b **\uc0\u32431 \u25991 \u26412 \u21518 \u32493 \u28040 \u24687 **
\f0\b0 \uc0\u65288 \u22914 \u39564 \u35777 \u30721  `516345`\u12289 \u25163 \u26426 \u21495  `18936019486`\u65289 \u65292 \u26032  Run \u21551 \u21160 \u26102 \u65306 \
\
  1. 
\f1\b **\uc0\u20840 \u37096 
\f0\b0  
\f1\b Playwright
\f0\b0  
\f1\b \uc0\u24037 \u20855 \u28040 \u22833 **
\f0\b0 \uc0\u65292 \u20165 \u21097  `browser_navigate` / `browser_navigate_back`\u65288 \u25110 \u23436 \u20840 \u20026 \u38646 \u65289 \
  2. Agent \uc0\u22768 \u31216 "\u27983 \u35272 \u22120 \u24037 \u20855 \u23558 \u22312 \u19979 \u19968 \u36718 \u33258 \u21160 \u24674 \u22797 "\'97\'97
\f1\b **\uc0\u23454 \u38469 \u19981 \u20250 \u24674 \u22797 **
\f0\b0 \
  3. \uc0\u27983 \u35272 \u22120 \u39029 \u38754 \u21464 \u20026  `about:blank`\u65292 \u20043 \u21069 \u22635 \u20889 \u30340 \u34920 \u21333 \u25968 \u25454 \u20840 \u37096 \u20002 \u22833 \
  4. \uc0\u21518 \u32493 \u25152 \u26377  Run \u22343 \u26080 \u27861 \u24674 \u22797 \u27983 \u35272 \u22120 \u24037 \u20855 \u65292 \u24418 \u25104 
\f1\b **\uc0\u19981 \u21487 \u33258 \u24840 \u30340 \u27515 \u24490 \u29615 **
\f0\b0 \
\
  ## \uc0\u20108 \u12289 \u25991 \u26723 \u32034 \u24341 \u65288 \u24050 \u26377 \u30456 \u20851 \u25991 \u26723 \u65289 \
\
  | \uc0\u25991 \u26723  | \u20851 \u31995  |\
  |------|------|\
  | `docs/specs/fix-mcp-tool-disappearance-v1.md` | \uc0\u30452 \u25509 \u21069 \u39537 \u65292 commit `fb35a13` \u24050 \u23454 \u26045  4 \u20010  Fix\u65288 Run \u20869 \u34917 \u40784 \u65289 \u65292 \u20294 \u26410 \u35299 \u20915 \u36328  Run \u38382 \u39064  |\
  | `docs/research/mcp-session-reliability-and-thread-accounting-repair-v1.md` | MCP \uc0\u20250 \u35805 \u21487 \u38752 \u24615 \u30740 \u31350 \u65292 Thread/Turn/Item \u26550 \u26500  |\
  | `docs/specs/thread-waiting-user-state-v0.1.md` | workflowV1 \uc0\u29366 \u24577 \u27169 \u22411 \u35774 \u35745  |\
\
  ## \uc0\u19977 \u12289 \u26681 \u22240 \u20998 \u26512 \u65288 5 \u23618 \u35843 \u29992 \u38142 \u36880 \u23618 \u22833 \u36133 \u65289 \
\
  
\f1\b **\uc0\u33539 \u24335 \u32423 \u26681 \u22240 **
\f0\b0 \uc0\u65306 \u24037 \u20855 \u36873 \u25321 \u31649 \u32447 \u65288 tool selection pipeline\u65289 \u23558 \u27599 \u20010  Run \u35270 \u20026 \u26080 \u29366 \u24577 \u30340 \u29420 \u31435 \u35831 \u27714 \u12290 \u20250 \u35805 \u32423 \u29366 \u24577  `workflowV1` \u34429 \u28982 \u23384 \u22312 \u65292 \u20294 \u34987  `looksLikeWorkflowContinuationPrompt`\
  \uc0\u27491 \u21017 \u38376 \u25511 \u25318 \u25130 \u65292 \u26410 \u33021 \u36827 \u20837 \u24037 \u20855 \u36873 \u25321 \u30340 "\u30828 \u32422 \u26463 \u23618 "\u12290 \
\
  ### \uc0\u36880 \u23618 \u20998 \u26512 \u65306 \u29992 \u25143 \u21457 \u36865  `516345` \u26102 \u21457 \u29983 \u20102 \u20160 \u20040 \
\
  #### \uc0\u31532  1 \u23618 \u65306 `detectPromptCapabilities("516345")` \u8594  \u31354 \u38598  \u10060 \
\
  
\f1\b **\uc0\u20301 \u32622 **
\f0\b0 \uc0\u65306 `apps/gateway/src/agent/toolCatalog.ts`\
\
  `detectPromptCapabilities` \uc0\u36890 \u36807 \u27491 \u21017 \u21305 \u37197 \u29992 \u25143  prompt \u20013 \u30340 \u33021 \u21147 \u26631 \u31614 \u65288 `browser_open`\u12289 `search`\u12289 `code_exec` \u31561 \u65289 \u12290 \u32431 \u25968 \u23383  `516345` \u19981 \u21305 \u37197 \u20219 \u20309 \u27491 \u21017 \u65292 \u36820 \u22238 \u31354  `Set<string>`\u12290 \
\
  
\f1\b **\uc0\u21518 \u26524 **
\f0\b0 \uc0\u65306 `browser_open` \u33021 \u21147 \u26410 \u34987 \u26816 \u27979 \u21040 \u65292 \u21518 \u32493 \u25152 \u26377 \u20381 \u36182  `promptCaps.has("browser_open")` \u30340 \u20998 \u25903 \u20840 \u37096 \u36208  false\u12290 \
\
  #### \uc0\u31532  2 \u23618 \u65306 `selectToolSubset` \u20013  Playwright \u24037 \u20855 \u24471 \u20998  \u8776  0\u65292 \u34987 \u25490 \u38500 \u20986  top-30 \u10060 \
\
  
\f1\b **\uc0\u20301 \u32622 **
\f0\b0 \uc0\u65306 `apps/gateway/src/agent/runFactory.ts:2953-2960` \u8594  `toolCatalog.ts:455+`\
\
  Playwright \uc0\u24037 \u20855 \u24471 \u20998 \u26469 \u28304 \u65306 \
  - `preferred` \uc0\u21152 \u20998  (+420)\u65306 \u38656 \u35201 \u22312  `preferredToolNames` \u20013  \u8594  \u19981 \u22312 \
  - `preserve` \uc0\u21152 \u20998  (+500)\u65306 \u38656 \u35201 \u22312  `preserveToolNames` \u20013  \u8594  \u19981 \u22312 \
  - `browser_entry_boost` (+80)\uc0\u65306 \u38656 \u35201  `caps.has("browser_open")` \u8594  \u31532  1 \u23618 \u24050 \u22833 \u36133 \
  - `capability` \uc0\u21152 \u20998  (+90/+70)\u65306 \u38656 \u35201  route capability \u21305 \u37197  \u8594  `516345` \u26080  route\
\
  Playwright \uc0\u24037 \u20855 \u26368 \u32456 \u24471 \u20998  \u8776  0\u65292 \u22312  top-30 \u31454 \u20105 \u20013 \u20840 \u37096 \u34987 \u28120 \u27760 \u12290 \
\
  #### \uc0\u31532  3 \u23618 \u65306 MCP Server \u31890 \u24230 \u34917 \u40784 \u26410 \u35302 \u21457  \u10060 \
\
  
\f1\b **\uc0\u20301 \u32622 **
\f0\b0 \uc0\u65306 `apps/gateway/src/agent/runFactory.ts:2976-3003`\
\
  \uc0\u34917 \u40784 \u36923 \u36753 \u65306 
\f2\i _\uc0\u22914 \u26524 
\f0\i0  
\f2\i `selectToolSubset`
\f0\i0  
\f2\i \uc0\u36873 \u20013 \u20102 \u26576 
\f0\i0  
\f2\i MCP
\f0\i0  
\f2\i Server
\f0\i0  
\f2\i \uc0\u30340 
\f3\b **\uc0\u20219 \u19968 **
\f2\b0 \uc0\u24037 \u20855 \u65292 \u21017 \u34917 \u40784 \u35813 
\f0\i0  
\f2\i Server
\f0\i0  
\f2\i \uc0\u30340 \u20840 \u37096 \u24037 \u20855 _
\f0\i0 \uc0\u12290 \
\
  \uc0\u20294 \u31532  2 \u23618 \u30340 \u32467 \u26524 \u26159 
\f1\b **\uc0\u38646 \u20010 **
\f0\b0  Playwright \uc0\u24037 \u20855 \u34987 \u36873 \u20013 \u65292 \u34917 \u40784 \u26465 \u20214  `tools.some(n => selectedAllowedToolNames.has(n))` \u20026  false\u65292 \u19981 \u35302 \u21457 \u12290 \
\
  #### \uc0\u31532  4 \u23618 \u65306 `allowBrowserToolsEffective` = false \u10060 \
\
  
\f1\b **\uc0\u20301 \u32622 **
\f0\b0 \uc0\u65306 `apps/gateway/src/agent/runFactory.ts:3046-3050`\
\
  ```typescript\
  const allowBrowserToolsEffective =\
    allowBrowserTools ||                           // \uc0\u8592  detectRunIntent \u26410 \u36335 \u30001 \u21040  web_radar \u8594  false\
    toolRetrieval.promptCaps.includes("browser_open") ||  // \uc0\u8592  \u31532  1 \u23618 \u24050 \u22833 \u36133  \u8594  false\
    injectedRetrievalToolNames.some(...)  ||        // \uc0\u8592  \u26080  browser \u24037 \u20855 \u34987 \u27880 \u20837  \u8594  false\
    Array.from(selectedAllowedToolNames).some(...); // \uc0\u8592  \u31532  2+3 \u23618 \u24050 \u22833 \u36133  \u8594  false\
\
  \uc0\u22235 \u20010  OR \u26465 \u20214 \u20840 \u37096 \u20026  false\u12290 \
\
  
\f1\b \uc0\u31532 
\f0\b0  
\f1\b 5
\f0\b0  
\f1\b \uc0\u23618 \u65306 \cf3 computePerTurnAllowed\cf2  \uc0\u20027 \u21160 \u21024 \u38500 \u25152 \u26377 \u27983 \u35272 \u22120 \u24037 \u20855 
\f0\b0  
\f1\b \uc0\u10060 \u10060 \u10060 
\f0\b0 \
\
  
\f1\b \uc0\u20301 \u32622 
\f0\b0 \uc0\u65306 \cf3 apps/gateway/src/agent/runFactory.ts:3570-3579\cf2 \
\
  \cf4 if\cf2  (!allowBrowserForTurn && browserMcpToolNames.size > \cf5 0\cf2 ) \{\
    \cf4 for\cf2  (\cf4 const\cf2  n \cf4 of\cf2  browserMcpToolNames) \{\
      \cf4 if\cf2  (allowed.delete(n)) removed += \cf5 1\cf2 ;\
    \}\
  \}\
\
  \uc0\u21363 \u20351 \u22240 \u20026 \u26576 \u31181 \u21407 \u22240 \u26377 \u23569 \u37327  Playwright \u24037 \u20855 \u27844 \u28431 \u36827  \cf3 allowed\cf2 \uc0\u65292 \u27492 \u22788 \u20063 \u20250 
\f1\b \uc0\u20027 \u21160 \u20840 \u37096 \u21024 \u38500 
\f0\b0 \uc0\u12290 \u36825 \u26159 \u26368 \u32456 \u30340 "\u28781 \u26432 \u23618 "\u12290 \
\
  
\f1\b \uc0\u20250 \u35805 \u29366 \u24577 \u23384 \u22312 \u20294 \u26410 \u34987 \u28040 \u36153 
\f0\b0 \
\
  \cf3 readWorkflowStickyState(mainDoc)\cf2  \uc0\u33021 \u27491 \u30830 \u35835 \u21462 \u19978 \u19968  Run \u20889 \u20837 \u30340  \cf3 workflowV1\cf2 \uc0\u65306 \
  - \cf3 routeId:\cf2  \cf3 "web_radar"\cf2 \
  - \cf3 kind:\cf2  \cf3 "browser_session"\cf2 \
  - \cf3 selectedServerIds:\cf2  \cf3 ["playwright"]\cf2 \
  - \cf3 preferredToolNames:\cf2  \cf3 ["mcp.playwright.browser_navigate",\cf2  \cf3 ...]\cf2 \
  - \cf3 isFresh:\cf2  \cf3 true\cf2 \uc0\u65288 45 \u20998 \u38047  TTL \u20869 \u65289 \
\
  \uc0\u20294  \cf3 resolveStickyMcpServerIds\cf2 \uc0\u65288 L1190-1207\u65289 \u35201 \u27714 \u65306 \
\
  \cf4 if\cf2  (!looksLikeWorkflowContinuationPrompt(prompt)) \cf4 return\cf2  [];  \cf5 //\cf2  \cf5 \uc0\u8592 \cf2  \cf5 \uc0\u38376 \u25511 \u65281 \cf2 \
\
  \cf3 looksLikeWorkflowContinuationPrompt("516345")\cf2  \uc0\u8594  
\f1\b false
\f0\b0 \uc0\u65292 \u22240 \u20026 \u35813 \u20989 \u25968 \u20165 \u21305 \u37197 \u65306 \
  - \cf3 looksLikeShortFollowUp\cf2 \uc0\u65306 \u8804 12 \u23383 \u31526 \u30340 \u20013 \u25991 \u30830 \u35748 \u35789 \u65288 \u32487 \u32493 /\u22909 /\u34892 \'85\u65289 \
  - 1-2 \uc0\u20301 \u25968 \u23383 \u65288 \cf3 \\d\{1,2\}\cf2 \uc0\u65289 \
  - \uc0\u29305 \u23450 \u20013 \u25991 \u21160 \u20316 \u35789 \u65288 \u32487 \u32493 /\u19979 \u19968 \u27493 /\u25130 \u22270 \'85\u65289 \
\
  
\f1\b 6
\f0\b0  
\f1\b \uc0\u20301 \u25968 \u23383 
\f0\b0  
\f1\b \cf3 516345\cf2  \uc0\u19981 \u21305 \u37197 \u20219 \u20309 \u27169 \u24335 
\f0\b0 \uc0\u12290 \u21516 \u29702 \u65292 \cf3 detectRunIntent\cf2  \uc0\u20013 \u30340  sticky \u32487 \u25215 \u20063 \u34987 \u21516 \u19968 \u38376 \u25511 \u25318 \u25130 \u65288 L1600-1604\u65289 \u12290 \
\
  
\f1\b \uc0\u22235 \u12289 \u24433 \u21709 \u33539 \u22260 
\f0\b0 \
\
  
\f1\b \uc0\u30452 \u25509 \u21463 \u23475 \u32773 
\f0\b0 \
\
  \uc0\u9484 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9516 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9516 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9488 \
  \uc0\u9474                      \u22330 \u26223                      \u9474  \u20005 \u37325 \u24230  \u9474                     \u35828 \u26126                     \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  Playwright MCP \u36328  Run \u32493 \u25805 \u20316                  \u9474  
\f1\b P0
\f0\b0      \uc0\u9474  \u34920 \u21333 \u22635 \u20889 \u12289 \u30331 \u24405 \u27969 \u31243 \u12289 \u22810 \u27493 \u39588 \u32593 \u39029 \u25805 \u20316 \u20840 \u37096 \u20013 \u26029  \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  \u20219 \u20309  Playwright \u24037 \u20316 \u27969 \u20013 \u21457 \u36865 \u39564 \u35777 \u30721 /\u25968 \u23383 /\u38142 \u25509  \u9474  
\f1\b P0
\f0\b0      \uc0\u9474  \u26368 \u24120 \u35265 \u30340 \u36328  Run \u35302 \u21457 \u22330 \u26223                     \u9474 \
  \uc0\u9492 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9524 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9524 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9496 \
\
  
\f1\b \uc0\u21516 \u31867 \u21463 \u23475 \u32773 \u65288 \u25152 \u26377 \u26377 \u29366 \u24577 
\f0\b0  
\f1\b MCP\uc0\u65289 
\f0\b0 \
\
  \uc0\u9484 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9516 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9516 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9488 \
  \uc0\u9474     MCP Server    \u9474               \u22330 \u26223                \u9474  \u20005 \u37325 \u24230  \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  Word MCP         \u9474  \u21019 \u24314 \u25991 \u26723 \u21518 \u29992 \u25143 \u35828 "\u21152 \u20010 \u34920 \u26684 "      \u9474  P1     \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  Excel MCP        \u9474  \u25171 \u24320 \u24037 \u20316 \u31807 \u21518 \u29992 \u25143 \u35828 "\u31532 \u19977 \u34892 \u25913 \u25104 \'85" \u9474  P1     \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  PDF MCP          \u9474  \u29983 \u25104  PDF \u21518 \u29992 \u25143 \u35828 "\u20877 \u21152 \u19968 \u39029 "     \u9474  P1     \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  Terminal/SSH MCP \u9474  \u25191 \u34892 \u21629 \u20196 \u21518 \u29992 \u25143 \u35828 "\u32467 \u26524 \u21602 "        \u9474  P1     \u9474 \
  \uc0\u9492 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9524 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9524 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9496 \
\
  
\f1\b \uc0\u20849 \u21516 \u27169 \u24335 
\f0\b0 \uc0\u65306 \u29992 \u25143 \u21457 \u36865 \u30340 \u21518 \u32493 \u28040 \u24687 \u19981 \u21547 \u35813  MCP \u30340 \u33021 \u21147 \u20851 \u38190 \u35789 \u65292 \u23548 \u33268 \u24037 \u20855 \u36873 \u25321 \u31649 \u32447 \u23558 \u20854 \u25490 \u38500 \u12290 \
\
  
\f1\b \uc0\u29420 \u31435 \u38382 \u39064 \u65288 \u19978 \u28216 \u65289 
\f0\b0 \
\
  Playwright MCP \uc0\u36827 \u31243 /\u27983 \u35272 \u22120 \u19978 \u19979 \u25991 \u23849 \u28291 \u26159 \u29420 \u31435 \u38382 \u39064 \u65288 microsoft/playwright-mcp #1045\u12289 #1307\u12289 #1140\u65289 \u65292 \u19981 \u22312 \u26412  spec \u20462 \u22797 \u33539 \u22260 \u20869 \u12290 \u26412  spec \u20165 \u20462 \u22797 
\f1\b \uc0\u25105 \u20204 \u30340 \u24037 \u20855 \u36873 \u25321 \u31649 \u32447 
\f0\b0 \uc0\u12290 \
\
  
\f1\b \uc0\u20116 \u12289 \u20462 \u22797 \u26041 \u26696 
\f0\b0 \
\
  
\f1\b \uc0\u35774 \u35745 \u21407 \u21017 
\f0\b0 \
\
  
\f1\b \uc0\u21453 \u36716 \u40664 \u35748 \u36923 \u36753 
\f0\b0 \uc0\u65306 \u24403 \u21069 \u36923 \u36753 \u26159 "\u35777 \u26126 \u20320 \u38656 \u35201 \u25165 \u32473 \u20320 \u24037 \u20855 "\u65288 opt-in\u65289 \u65292 \u25913 \u20026 "\u26377 \u27963 \u36291 \u20250 \u35805 \u23601 \u40664 \u35748 \u32487 \u25215 \u65292 \u38500 \u38750 \u26126 \u30830 \u24320 \u21551 \u26032 \u20219 \u21153 "\u65288 opt-out\u65289 \u12290 \
\
  \uc0\u20855 \u20307 \u23454 \u29616 \u20351 \u29992 \u29616 \u26377  \cf3 workflowV1\cf2  \uc0\u22522 \u30784 \u35774 \u26045 \u65292 \u19981 \u24341 \u20837 \u26032 \u30340 \u29366 \u24577 \u23384 \u20648 \u12290 \
\
  
\f1\b Fix
\f0\b0  
\f1\b 1\uc0\u65306 \cf3 allowBrowserToolsEffective\cf2  \uc0\u22686 \u21152 \u20250 \u35805 \u24863 \u30693 
\f0\b0 \
\
  
\f1\b \uc0\u25991 \u20214 
\f0\b0 \uc0\u65306 \cf3 apps/gateway/src/agent/runFactory.ts:3046-3050\cf2 \
\
  
\f1\b \uc0\u24403 \u21069 
\f0\b0 \uc0\u65306 \
  \cf4 const\cf2  allowBrowserToolsEffective =\
    allowBrowserTools ||\
    toolRetrieval.promptCaps.includes(\cf6 "browser_open"\cf2 ) ||\
    injectedRetrievalToolNames.some(\cf7 (name)\cf2  \cf7 =>\cf2  \cf6 /^mcp\\.[^.]*?(?:playwright|browser)[^.]*\\./i\cf2 .test(\cf8 String\cf2 (name ?? \cf6 ""\cf2 ))) ||\
    \cf8 Array\cf2 .from(selectedAllowedToolNames).some(\cf7 (name)\cf2  \cf7 =>\cf2  \cf6 /^mcp\\.[^.]*?(?:playwright|browser)[^.]*\\./i\cf2 .test(\cf8 String\cf2 (name ?? \cf6 ""\cf2 )));\
\
  
\f1\b \uc0\u20462 \u25913 \u20026 
\f0\b0 \uc0\u65306 \
  \cf4 const\cf2  browserSessionActive = isBrowserSessionActive(mainDocFromPack, userPrompt);\
\
  \cf4 const\cf2  allowBrowserToolsEffective =\
    allowBrowserTools ||\
    browserSessionActive ||  \cf5 //\cf2  \cf5 \uc0\u8592 \cf2  \cf5 \uc0\u26032 \u22686 \u65306 \u27963 \u36291 \u27983 \u35272 \u22120 \u20250 \u35805 \u33258 \u21160 \u25918 \u34892 \cf2 \
    toolRetrieval.promptCaps.includes(\cf6 "browser_open"\cf2 ) ||\
    injectedRetrievalToolNames.some(\cf7 (name)\cf2  \cf7 =>\cf2  \cf6 /^mcp\\.[^.]*?(?:playwright|browser)[^.]*\\./i\cf2 .test(\cf8 String\cf2 (name ?? \cf6 ""\cf2 ))) ||\
    \cf8 Array\cf2 .from(selectedAllowedToolNames).some(\cf7 (name)\cf2  \cf7 =>\cf2  \cf6 /^mcp\\.[^.]*?(?:playwright|browser)[^.]*\\./i\cf2 .test(\cf8 String\cf2 (name ?? \cf6 ""\cf2 )));\
\
  
\f1\b \uc0\u25928 \u26524 
\f0\b0 \uc0\u65306 \u35299 \u38500 \u31532  4\u12289 5 \u23618 \u30340 \u28781 \u26432 \'97\'97\cf3 computePerTurnAllowed\cf2  \uc0\u19981 \u20877 \u21024 \u38500 \u27983 \u35272 \u22120 \u24037 \u20855 \u12290 \
\
  
\f1\b Fix
\f0\b0  
\f1\b 2\uc0\u65306 \cf3 resolveStickyMcpServerIds\cf2  \uc0\u21435 \u38500 
\f0\b0  
\f1\b continuation
\f0\b0  
\f1\b \uc0\u27491 \u21017 \u38376 \u25511 
\f0\b0 \
\
  
\f1\b \uc0\u25991 \u20214 
\f0\b0 \uc0\u65306 \cf3 apps/gateway/src/agent/runFactory.ts:1190-1207\cf2 \
\
  
\f1\b \uc0\u24403 \u21069 
\f0\b0 \uc0\u65306 \
  \cf4 if\cf2  (!looksLikeWorkflowContinuationPrompt(prompt)) \cf4 return\cf2  [];  \cf5 //\cf2  \cf5 \uc0\u8592 \cf2  \cf5 \uc0\u36807 \u20005 \cf2 \
\
  
\f1\b \uc0\u20462 \u25913 \u20026 
\f0\b0 \uc0\u65306 \
  \cf5 //\cf2  \cf5 \uc0\u21453 \u36716 \u36923 \u36753 \u65306 \u40664 \u35748 \u32487 \u25215 \u65292 \u20165 \u22312 "\u26126 \u30830 \u26032 \u20219 \u21153 "\u26102 \u26029 \u24320 \cf2 \
  \cf4 if\cf2  (looksLikeExplicitNewTaskPrompt(prompt)) \cf4 return\cf2  [];\
\
  \uc0\u26032 \u22686 \u36741 \u21161 \u20989 \u25968  \cf3 looksLikeExplicitNewTaskPrompt\cf2 \uc0\u65306 \
  \cf4 export\cf2  \cf4 function\cf7  looksLikeExplicitNewTaskPrompt(text:\cf2  \cf8 string\cf7 ):\cf2  \cf7 boolean\cf2  \{\
    \cf4 const\cf2  t = \cf8 String\cf2 (text ?? \cf6 ""\cf2 ).trim();\
    \cf4 if\cf2  (!t) \cf4 return\cf2  \cf4 false\cf2 ;\
    \cf5 //\cf2  \cf5 \uc0\u26126 \u30830 \u24320 \u21551 \u26032 \u20219 \u21153 \u30340 \u20449 \u21495 \cf2 \
    \cf4 if\cf2  (\cf6 /^(\uc0\u24110 \u25105 |\u35831 |\u40635 \u28902 |\u25105 \u24819 |\u25105 \u35201 |\u33021 \u19981 \u33021 |\u21487 \u20197 \u24110 \u25105 |\u20889 \u19968 \u20010 |\u20570 \u19968 \u20010 |\u21019 \u24314 |\u26032 \u24314 |\u20998 \u26512 |\u24635 \u32467 |\u32763 \u35793 )/\cf2 .test(t) && t.length > \cf5 15\cf2 ) \cf4 return\cf2  \cf4 true\cf2 ;\
    \cf5 //\cf2  \cf5 \uc0\u26126 \u30830 \u19982 \u27983 \u35272 \u22120 /\u32593 \u39029 \u26080 \u20851 \u30340 \u20219 \u21153 \cf2 \
    \cf4 if\cf2  (looksLikeResearchOnlyPrompt(t)) \cf4 return\cf2  \cf4 true\cf2 ;\
    \cf4 if\cf2  (looksLikeExplicitNonTaskPrompt(t)) \cf4 return\cf2  \cf4 true\cf2 ;\
    \cf4 return\cf2  \cf4 false\cf2 ;\
  \}\
\
  
\f1\b \uc0\u25928 \u26524 
\f0\b0 \uc0\u65306 \cf3 516345\cf2 \uc0\u12289 \cf3 18936019486\cf2 \uc0\u12289 \cf3 \uc0\u39564 \u35777 \u30721 \u26159 \cf2  \cf3 438291\cf2  \uc0\u31561 \u28040 \u24687 \u19981 \u20250 \u35302 \u21457 "\u26032 \u20219 \u21153 "\u21028 \u23450 \u65292 sticky serverIds \u27491 \u24120 \u32487 \u25215 \u12290 \
\
  
\f1\b Fix
\f0\b0  
\f1\b 3\uc0\u65306 \cf3 selectToolSubset\cf2  \uc0\u28040 \u36153 
\f0\b0  
\f1\b sticky
\f0\b0  
\f1\b \cf3 preferredToolNames
\f0\b0 \cf2 \
\
  
\f1\b \uc0\u25991 \u20214 
\f0\b0 \uc0\u65306 \cf3 apps/gateway/src/agent/runFactory.ts:2953-2960\cf2 \uc0\u65288 \u35843 \u29992 \u20391 \u65289 \
\
  
\f1\b \uc0\u24403 \u21069 
\f0\b0 \uc0\u65306 \cf3 readWorkflowStickyState\cf2  \uc0\u24050 \u35299 \u26512  \cf3 preferredToolNames\cf2 \uc0\u65292 \u20294 \u26410 \u20256 \u20837  \cf3 selectToolSubset\cf2 \uc0\u12290 \
\
  
\f1\b \uc0\u20462 \u25913 
\f0\b0 \uc0\u65306 \u22312  \cf3 selectToolSubset\cf2  \uc0\u35843 \u29992 \u21069 \u65292 \u23558  sticky preferredToolNames \u21512 \u24182 \u21040  \cf3 preferredToolNamesWithRetrieval\cf2 \uc0\u65306 \
\
  \cf5 //\cf2  \cf5 \uc0\u27963 \u36291 \u20250 \u35805 \u30340 \cf2  \cf5 sticky\cf2  \cf5 \uc0\u24037 \u20855 \u21517 \u27880 \u20837 \cf2  \cf5 preferred\uc0\u65288 +420\cf2  \cf5 \uc0\u20998 \u65289 \cf2 \
  \cf4 const\cf2  stickyState = readWorkflowStickyState(mainDocFromPack);\
  \cf4 if\cf2  (stickyState.isFresh && !looksLikeExplicitNewTaskPrompt(userPrompt)) \{\
    \cf4 for\cf2  (\cf4 const\cf2  name \cf4 of\cf2  stickyState.preferredToolNames) \{\
      \cf4 if\cf2  (!preferredToolNamesWithRetrieval.includes(name)) \{\
        preferredToolNamesWithRetrieval.push(name);\
      \}\
    \}\
  \}\
\
  \cf4 const\cf2  toolSelection = selectToolSubset(\{\
    \cf8 catalog\cf2 : toolCatalog,\
    \cf8 routeId\cf2 : routeIdLower || intentRoute.routeId,\
    userPrompt,\
    \cf8 preferredToolNames\cf2 : preferredToolNamesWithRetrieval,\
    \cf8 preserveToolNames\cf2 : \cf8 Array\cf2 .from(preserveToolNamesWithComposite),\
    \cf8 maxTools\cf2 : maxToolsForMode,\
  \});\
\
  
\f1\b \uc0\u25928 \u26524 
\f0\b0 \uc0\u65306 Playwright \u24037 \u20855 \u33719 \u24471  +420 \u20998 \u21152 \u25104 \u65292 \u22312  top-30 \u31454 \u20105 \u20013 \u31283 \u23450 \u20837 \u36873 \u12290 \u37197 \u21512  Fix 1\u65288 MCP Server \u31890 \u24230 \u34917 \u40784 \u20173 \u28982 \u29983 \u25928 \u65289 \u65292 \u20840 \u37096  Playwright \u24037 \u20855 \u37117 \u20250 \u34987 \u36873 \u20837 \u12290 \
\
  
\f1\b Fix
\f0\b0  
\f1\b 4\uc0\u65306 \cf3 detectRunIntent\cf2  \uc0\u32487 \u25215 
\f0\b0  
\f1\b \cf3 routeId=web_radar
\f0\b0 \cf2 \
\
  
\f1\b \uc0\u25991 \u20214 
\f0\b0 \uc0\u65306 \cf3 packages/agent-core/src/runMachine.ts:300+\cf2 \uc0\u65288 \u25110  \cf3 runFactory.ts:1600+\cf2 \uc0\u65289 \
\
  
\f1\b \uc0\u24403 \u21069 
\f0\b0 \uc0\u65288 L1600-1604\u65289 \u65306 \
  \cf4 const\cf2  stickyFollowUp =\
    !looksLikeResearchOnly &&\
    !looksLikeExplicitNonTaskPrompt(pTrim) &&\
    looksLikeWorkflowContinuationPrompt(pTrim);  \cf5 //\cf2  \cf5 \uc0\u8592 \cf2  \cf5 \uc0\u36807 \u20005 \cf2 \
\
  
\f1\b \uc0\u20462 \u25913 \u20026 
\f0\b0 \uc0\u65306 \
  \cf4 const\cf2  stickyFollowUp =\
    !looksLikeResearchOnly &&\
    !looksLikeExplicitNonTaskPrompt(pTrim) &&\
    !looksLikeExplicitNewTaskPrompt(pTrim);  \cf5 //\cf2  \cf5 \uc0\u8592 \cf2  \cf5 \uc0\u21453 \u36716 \u65306 \u38750 \u26032 \u20219 \u21153 \u21363 \u32487 \u25215 \cf2 \
\
  
\f1\b \uc0\u25928 \u26524 
\f0\b0 \uc0\u65306 \cf3 detectRunIntent\cf2  \uc0\u22312  workflowV1 fresh + \u38750 \u26032 \u20219 \u21153 \u26102 \u32487 \u25215  \cf3 routeId=web_radar\cf2 \uc0\u65292 \u21518 \u32493  \cf3 allowBrowserTools\cf2  \uc0\u36890 \u36807  route capability \u33258 \u28982 \u20026  true\u12290 \
\
  
\f1\b \uc0\u26032 \u22686 \u36741 \u21161 \u20989 \u25968 \u65306 \cf3 isBrowserSessionActive
\f0\b0 \cf2 \
\
  \cf4 export\cf2  \cf4 function\cf7  isBrowserSessionActive(mainDoc:\cf2  \cf7 unknown,\cf2  \cf7 userPrompt:\cf2  \cf8 string\cf7 ):\cf2  \cf7 boolean\cf2  \{\
    \cf4 const\cf2  wf = readWorkflowStickyState(mainDoc);\
    \cf4 if\cf2  (!wf.isFresh) \cf4 return\cf2  \cf4 false\cf2 ;\
    \cf4 const\cf2  browserLike =\
      wf.routeId === \cf6 "web_radar"\cf2  ||\
      wf.kind === \cf6 "browser_session"\cf2  ||\
      wf.selectedServerIds.some(\cf7 (id)\cf2  \cf7 =>\cf2  \cf6 /playwright|browser/i\cf2 .test(id));\
    \cf4 if\cf2  (!browserLike) \cf4 return\cf2  \cf4 false\cf2 ;\
    \cf5 //\cf2  \cf5 \uc0\u21453 \u36716 \u36923 \u36753 \u65306 \u40664 \u35748 \u27963 \u36291 \u65292 \u20165 \u22312 \u26126 \u30830 \u26032 \u20219 \u21153 \u26102 \u26029 \u24320 \cf2 \
    \cf4 const\cf2  prompt = \cf8 String\cf2 (userPrompt ?? \cf6 ""\cf2 ).trim();\
    \cf4 if\cf2  (looksLikeExplicitNewTaskPrompt(prompt)) \cf4 return\cf2  \cf4 false\cf2 ;\
    \cf4 return\cf2  \cf4 true\cf2 ;\
  \}\
\
  
\f1\b \uc0\u20845 \u12289 \u26550 \u26500 \u38544 \u24739 \u19982 \u21518 \u32493 \u32771 \u34385 
\f0\b0 \
\
  
\f1\b 1.
\f0\b0  
\f1\b \cf3 looksLikeWorkflowContinuationPrompt\cf2  \uc0\u30340 \u23450 \u20301 
\f0\b0 \
\
  \uc0\u20462 \u22797 \u21518 \u35813 \u20989 \u25968 \u20173 \u20445 \u30041 \u65292 \u20294 \u19981 \u20877 \u20316 \u20026  sticky \u32487 \u25215 \u30340 \u21807 \u19968 \u38376 \u25511 \u12290 \u23427 \u36864 \u21270 \u20026 \u19968 \u20010 "\u24378 \u20449 \u21495 "\u36741 \u21161 \u20989 \u25968 \u65292 \u29992 \u20110 \u20854 \u20182 \u22330 \u26223 \u65288 \u22914  \cf3 shouldSuppressSearchDuringBrowserContinuation\cf2 \uc0\u65289 \u12290 \
\
  
\f1\b 2.
\f0\b0  
\f1\b workflowV1
\f0\b0  
\f1\b TTL\uc0\u65288 45
\f0\b0  
\f1\b \uc0\u20998 \u38047 \u65289 
\f0\b0 \
\
  \cf3 WORKFLOW_STICKY_MAX_AGE_MS\cf2  \uc0\u24403 \u21069 \u20026  45 \u20998 \u38047 \u12290 \u23545 \u20110  ICP \u22791 \u26696 \u36825 \u31867 \u38271 \u27969 \u31243 \u21487 \u33021 \u19981 \u22815 \u12290 \u24314 \u35758 \u65306 \
  - \uc0\u30701 \u26399 \u65306 \u20445 \u25345  45 \u20998 \u38047 \u65292 \u36275 \u22815 \u35206 \u30422 \u32477 \u22823 \u22810 \u25968 \u22330 \u26223 \
  - \uc0\u20013 \u26399 \u65306 Agent \u22312 \u27599 \u20010  Run \u32467 \u26463 \u26102 \u21047 \u26032  \cf3 workflowV1.updatedAt\cf2 \uc0\u65292 \u37325 \u32622  TTL\
\
  
\f1\b 3.
\f0\b0  
\f1\b MCP
\f0\b0  
\f1\b \uc0\u36827 \u31243 \u26029 \u36830 \u26816 \u27979 
\f0\b0 \
\
  \uc0\u24403 \u21069  Desktop \u31471  \cf3 mcp-manager.mjs\cf2  \uc0\u27809 \u26377  MCP \u36827 \u31243 \u30340 \u24515 \u36339 \u26816 \u27979 \u12290 Playwright \u36827 \u31243 \u38745 \u40664 \u36864 \u20986 \u21518 \u65292 \u19979 \u19968 \u27425 \u24037 \u20855 \u35843 \u29992 \u25165 \u20250 \u21457 \u29616 \u36830 \u25509 \u26029 \u24320 \u65288 \cf3 _recoverStatefulToolCall\cf2  \uc0\u35302 \u21457 \u37325 \u36830 \u65289 \u12290 \u36825 \u26159 \u29420 \u31435 \u38382 \u39064 \u65292 \u19981 \u22312 \u26412  Fix \u33539 \u22260 \u12290 \
\
  
\f1\b 4.
\f0\b0  
\f1\b \uc0\u21516 \u31867 
\f0\b0  
\f1\b MCP
\f0\b0  
\f1\b \uc0\u30340 
\f0\b0  
\f1\b sticky
\f0\b0  
\f1\b \uc0\u32487 \u25215 
\f0\b0 \
\
  Fix 2-4 \uc0\u30340 \u36923 \u36753 \u23545 \u25152 \u26377  MCP Server \u29983 \u25928 \u65288 \cf3 resolveStickyMcpServerIds\cf2  \uc0\u19981 \u38480 \u20110  Playwright\u65289 \u12290 Word/Excel/PDF/Terminal MCP \u30340 \u36328  Run \u32493 \u25805 \u20316 \u21516 \u26679 \u21463 \u30410 \u12290 \
\
  
\f1\b \uc0\u19971 \u12289 \u39564 \u35777 
\f0\b0  
\f1\b Checklist
\f0\b0 \
\
  
\f1\b \uc0\u22238 \u24402 \u27979 \u35797 
\f0\b0 \
\
  - \cf3 npm\cf2  \cf3 -w\cf2  \cf3 @ohmycrab/gateway\cf2  \cf3 run\cf2  \cf3 test:runner-turn\cf2 \uc0\u65288 6 \u22330 \u26223 \u35206 \u30422 \u65289 \
\
  
\f1\b \uc0\u22330 \u26223 \u39564 \u35777 
\f0\b0 \
\
  \uc0\u9484 \u9472 \u9472 \u9472 \u9472 \u9472 \u9516 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9516 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9516 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9488 \
  \uc0\u9474   #  \u9474                              \u22330 \u26223                              \u9474            \u39044 \u26399            \u9474                  \u39564 \u35777 \u26041 \u24335                  \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  1   \u9474  \u39318 \u27425  Run \u20351 \u29992  Playwright \u8594  \u29992 \u25143 \u21457 \u36865  6 \u20301 \u39564 \u35777 \u30721  \u8594  \u26032  Run      \u9474  \u20840 \u37096  Playwright \u24037 \u20855 \u20445 \u30041  \u9474  \u26816 \u26597  Run \u26085 \u24535 \u20013  \cf3 selectedAllowedToolNames\cf2  \uc0\u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  2   \u9474  \u39318 \u27425  Run \u20351 \u29992  Playwright \u8594  \u29992 \u25143 \u21457 \u36865 \u25163 \u26426 \u21495  \u8594  \u26032  Run           \u9474  \u20840 \u37096  Playwright \u24037 \u20855 \u20445 \u30041  \u9474  \u21516 \u19978                                      \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  3   \u9474  \u39318 \u27425  Run \u20351 \u29992  Playwright \u8594  \u29992 \u25143 \u21457 \u36865 "\u24110 \u25105 \u20889 \u19968 \u31687 \u25991 \u31456 " \u8594  \u26032  Run \u9474  Playwright \u24037 \u20855 
\f1\b \uc0\u19981 
\f0\b0 \uc0\u32487 \u25215     \u9474  \cf3 looksLikeExplicitNewTaskPrompt\cf2  \uc0\u21629 \u20013       \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  4   \u9474  \u26080  Playwright \u20250 \u35805  \u8594  \u29992 \u25143 \u21457 \u36865  \cf3 516345\cf2                          \uc0\u9474  \u19981 \u20250 \u35823 \u35302 \u21457 \u27983 \u35272 \u22120 \u24037 \u20855      \u9474  \cf3 wf.isFresh\cf2  = false\uc0\u65292 \u19981 \u32487 \u25215                \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  5   \u9474  Playwright \u20250 \u35805 \u36229 \u36807  45 \u20998 \u38047  \u8594  \u29992 \u25143 \u21457 \u36865 \u21518 \u32493 \u28040 \u24687                \u9474  \u19981 \u32487 \u25215 \u65288 TTL \u36807 \u26399 \u65289        \u9474  \cf3 isFresh\cf2  = false                          \uc0\u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  6   \u9474  Word MCP \u20250 \u35805  \u8594  \u29992 \u25143 \u21457 \u36865 "\u21152 \u20010 \u34920 \u26684 "                           \u9474  Word MCP \u24037 \u20855 \u20445 \u30041         \u9474  Fix 2-3 \u23545 \u25152 \u26377  MCP \u29983 \u25928                   \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  7   \u9474  Playwright \u20250 \u35805  \u8594  \u29992 \u25143 \u21457 \u36865 "\u36825 \u20010 \u38382 \u39064 \u24590 \u20040 \u29702 \u35299 "                 \u9474  \u19981 \u32487 \u25215 \u65288 research only\u65289   \u9474  \cf3 looksLikeResearchOnlyPrompt\cf2  \uc0\u21629 \u20013          \u9474 \
  \uc0\u9492 \u9472 \u9472 \u9472 \u9472 \u9472 \u9524 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9524 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9524 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9496 \
\
  
\f1\b \uc0\u36793 \u30028 \u26816 \u26597 
\f0\b0 \
\
  - \cf3 looksLikeExplicitNewTaskPrompt\cf2  \uc0\u19981 \u20250 \u35823 \u21028 \u30701 \u30830 \u35748 \u28040 \u24687 \u65288 "\u22909 "\u12289 "\u32487 \u32493 "\u12289 "1"\u65289 \
  - \cf3 looksLikeExplicitNewTaskPrompt\cf2  \uc0\u27491 \u30830 \u35782 \u21035 \u26126 \u30830 \u26032 \u20219 \u21153 \u65288 "\u24110 \u25105 \u20889 \u19968 \u20010 \u29228 \u34411 \u33050 \u26412 "\u65289 \
  - \cf3 isBrowserSessionActive\cf2  \uc0\u22312  \cf3 workflowV1\cf2  \uc0\u32570 \u22833 \u25110 \u20026  null \u26102 \u23433 \u20840 \u36820 \u22238  false\
  - sticky \cf3 preferredToolNames\cf2  \uc0\u27880 \u20837 \u19981 \u36229 \u36807  16 \u20010 \u65288 \cf3 readWorkflowStickyState\cf2  \uc0\u24050 \u26377  \cf3 .slice(0,\cf2  \cf3 16)\cf2  \uc0\u38480 \u21046 \u65289 \
\
  
\f1\b \uc0\u20843 \u12289 \u23454 \u26045 \u20248 \u20808 \u32423 
\f0\b0 \
\
  \uc0\u9484 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9516 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9516 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9488 \
  \uc0\u9474  \u20248 \u20808 \u32423  \u9474                    Fix                   \u9474                                   \u29702 \u30001                                    \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  P0     \u9474  Fix 1 + Fix 2                           \u9474  \u35299 \u38500 \u28781 \u26432 \u23618  + \u24674 \u22797  sticky \u32487 \u25215 \u65292 \u20004 \u32773 \u37197 \u21512 \u21363 \u21487 \u20462 \u22797 \u26680 \u24515 \u38382 \u39064                  \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  P0     \u9474  Fix 4                                   \u9474  \u30830 \u20445  routeId \u32487 \u25215 \u65292 \u35753  \cf3 allowBrowserTools\cf2  \uc0\u33258 \u28982 \u29983 \u25928                         \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  P1     \u9474  Fix 3                                   \u9474  \u38182 \u19978 \u28155 \u33457 \'97\'97\u21363 \u20351 \u27809 \u26377  Fix 3\u65292 Fix 1+2+4 \u24050 \u36275 \u22815 \u12290 \u20294  Fix 3 \u25552 \u20379 \u39069 \u22806 \u30340 \u24471 \u20998 \u20445 \u38556  \u9474 \
  \uc0\u9500 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9532 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9508 \
  \uc0\u9474  \u21518 \u32493    \u9474  \cf3 looksLikeExplicitNewTaskPrompt\cf2  \uc0\u27491 \u21017 \u35843 \u20248  \u9474  \u19978 \u32447 \u21518 \u26681 \u25454 \u23454 \u38469 \u35823 \u21028 \u24773 \u20917 \u36845 \u20195                                               \u9474 \
  \uc0\u9492 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9524 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9524 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9472 \u9496 \
\
  ---\
}