# -*- coding: utf-8 -*-
"""
Markdown → HTML 片段（供 tools/export-doc.mjs 生成 PDF 用）

只在本地出文档时用，不参与项目运行。
用法：python tools/md2html.py <input.md> <output.html>
"""
import sys

import markdown


def main() -> int:
    if len(sys.argv) < 3:
        print('用法：python tools/md2html.py <input.md> <output.html>')
        return 1
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding='utf-8') as f:
        text = f.read()

    # 表格 / 代码块 / 有序列表 / 标题锚点，都是打印文档会用到的扩展
    body = markdown.markdown(
        text,
        extensions=['tables', 'fenced_code', 'sane_lists', 'attr_list', 'toc'],
        output_format='html5',
    )

    # 任务清单（- [ ] / - [x]）在打印件里换成方框，比原始符号好看
    body = body.replace('[ ]', '☐').replace('[x]', '☑')

    with open(dst, 'w', encoding='utf-8') as f:
        f.write(body)
    print(f'HTML 片段已生成：{dst}（{len(body)} 字符）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
