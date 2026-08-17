begin;

-- 学生邮箱的账号部分由学生自行设置，仅固定学校邮箱域名。
-- 旧版本误用了 @bjut.edu.cn；保留账号部分，迁移至正确学生邮箱域名。
alter table users drop constraint if exists users_school_email_check;

update users
set school_email = regexp_replace(
      lower(school_email),
      '@bjut[.]edu[.]cn$',
      '@emails.bjut.edu.cn'
    ),
    email_verified_at = case
      when verification_method = 'email' then null
      else email_verified_at
    end,
    verification_method = case
      when verification_method = 'email' then null
      else verification_method
    end
where school_email is not null
  and lower(school_email) ~ '@bjut[.]edu[.]cn$';

-- 旧验证码绑定的是错误收件地址，不能继续使用，也不应继续触发冷却。
delete from auth_tokens where purpose in ('verify_email', 'reset_password');

alter table users
  add constraint users_school_email_check
  check (
    school_email is null
    or lower(school_email) ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@emails[.]bjut[.]edu[.]cn$'
  );

commit;
