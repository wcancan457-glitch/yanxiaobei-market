begin;

insert into users (student_id, name, campus, password_hash)
values
  ('20231234', '燕小北同学', '平乐园校区', '!disabled'),
  ('20239999', '小周', '中蓝校区', '!disabled')
on conflict (student_id) do nothing;

insert into products
  (id, title, category, campus, campus_text, price, location, description,
   status, seller_id, image_url, created_at)
values
  ('p1', '近代史教材与重点笔记', '教材资料', 'pingleyuan', '平乐园校区', 18,
   '平乐园校区 · 图书馆门口', '教材干净，附复习重点和课堂笔记，适合期末复习。',
   'available', (select id from users where student_id = '20239999'),
   'assets/products/book.jpg', now() - interval '5 minutes'),
  ('p2', '宿舍护眼台灯', '生活用品', 'zhonglan', '中蓝校区', 35,
   '中蓝校区 · 食堂门口', '三档亮度，USB 供电，适合宿舍和自习使用。',
   'available', (select id from users where student_id = '20239999'),
   'assets/products/lamp.jpg', now() - interval '4 minutes'),
  ('p3', '校园通勤自行车', '生活用品', 'pingleyuan', '平乐园校区', 120,
   '平乐园校区 · 西门附近', '车况稳定，刹车刚调过，适合校内通勤。',
   'available', (select id from users where student_id = '20239999'),
   'assets/products/bike.jpg', now() - interval '3 minutes'),
  ('p4', '富士拍立得相机 mini', '数码电子', 'pingleyuan', '平乐园校区', 199,
   '平乐园校区 · 教学楼大厅', '成色很新，送两盒相纸，校园活动拍照超好用。',
   'available', (select id from users where student_id = '20231234'),
   'assets/products/camera.jpg', now() - interval '6 minutes'),
  ('p5', '无线降噪耳机', '数码电子', 'zhonglan', '中蓝校区', 89,
   '中蓝校区 · 宿舍楼下', '续航约 20 小时，自习降噪利器，附充电线。',
   'available', (select id from users where student_id = '20231234'),
   'assets/products/earphone.jpg', now() - interval '7 minutes'),
  ('p6', '纯棉基础款 T 恤', '服饰美妆', 'pingleyuan', '平乐园校区', 15,
   '平乐园校区 · 校门口', 'M 码，穿过两次，洗得干干净净。',
   'available', (select id from users where student_id = '20231234'),
   'assets/products/tshirt.jpg', now() - interval '8 minutes'),
  ('p7', '斯伯丁户外篮球', '运动户外', 'zhonglan', '中蓝校区', 45,
   '中蓝校区 · 操场边', '手感好，气已打足，毕业甩卖。',
   'available', (select id from users where student_id = '20231234'),
   'assets/products/basketball.jpg', now() - interval '9 minutes'),
  ('p8', '入门民谣吉他', '乐器文具', 'pingleyuan', '平乐园校区', 260,
   '平乐园校区 · 图书馆门口', '41 寸云杉面板，带琴包和变调夹，适合新手。',
   'available', (select id from users where student_id = '20239999'),
   'assets/products/guitar.jpg', now() - interval '10 minutes')
on conflict (id) do nothing;

insert into tasks
  (id, title, campus, campus_text, reward, location, description,
   status, publisher_id, created_at)
values
  ('t1', '帮忙取一份文件', 'zhonglan', '中蓝校区', 8,
   '中蓝校区 · 教学楼大厅', '今天 18:30 前帮忙取一份文件。', 'open',
   (select id from users where student_id = '20239999'), now() - interval '4 minutes'),
  ('t2', '毕业季闲置整理拍照', 'pingleyuan', '平乐园校区', 25,
   '平乐园校区 · 图书馆附近', '帮忙整理闲置并拍照，大约 1 小时。', 'open',
   (select id from users where student_id = '20239999'), now() - interval '3 minutes')
on conflict (id) do nothing;

commit;
