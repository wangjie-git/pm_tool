# 清理测试期间从微信导入的任务（备注以"来自微信"开头的记录）
import sqlite3

c = sqlite3.connect(r'C:\Users\MSI\AppData\Roaming\com.pmtodo.assistant\pm.db')
n = c.execute("SELECT COUNT(*) FROM tasks WHERE note LIKE '来自微信%'").fetchone()[0]
c.execute("DELETE FROM tasks WHERE note LIKE '来自微信%'")
c.commit()
print('deleted', n, 'wechat test tasks')
print('remaining tasks:', c.execute('SELECT COUNT(*) FROM tasks').fetchone()[0])
c.close()
