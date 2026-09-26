# افتقاد خورس القديس أبانوب

تطبيق بواجهة React وAPI بـ.NET 8 وقاعدة PostgreSQL. يحفظ زيارات البيت بالتاريخ، والاتصالات الأسبوعية، وتوزيع خادم لكل جروب، وتقرير تاريخ كل ولد، وإدارة الأسماء والعناوين والأرقام من داخل التطبيق.

## تشغيل محلي

المتطلبات: Docker Desktop و.NET 8 وNode.js.

1. من مجلد المشروع شغّل PostgreSQL محليًا:

   `docker run -d --name abanoub-followup-postgres -e POSTGRES_DB=choir_followup -e POSTGRES_USER=choir_app -e POSTGRES_PASSWORD=local-dev-only-password -p 127.0.0.1:55432:5432 -v abanoub_followup_pgdata:/var/lib/postgresql postgres:18`

2. انسخ `.env.example` إلى `.env`. للإعداد المحلي استخدم `DATABASE_URL=Host=127.0.0.1;Port=55432;Database=choir_followup;Username=choir_app;Password=local-dev-only-password` واجعل `APP_PASSWORD=abanoub-local` و`FRONTEND_ORIGIN=http://localhost:5174`.
3. شغّل الـAPI في نافذة Terminal:

   `dotnet run --project dotnet-api/FollowUp.Api`

4. في نافذة ثانية شغّل الواجهة:

   `cd react-app`

   `npm install`

   `npm run dev -- --host 127.0.0.1 --port 5174`

5. افتح `http://127.0.0.1:5174` وكلمة مرور الدخول المحلية `abanoub-local`.

تُنشأ جداول قاعدة البيانات تلقائيًا عند بدء الـAPI. استخدم Tab `إدارة الأسماء` لإضافة أو تعديل أو أرشفة أي اسم. قاعدة البيانات المحلية محفوظة في Docker volume.

## النشر

- **Neon:** أنشئ PostgreSQL وانسخ `DATABASE_URL`.
- **Render:** اربط مستودع GitHub، واختر Blueprint من `render.yaml`. أضف `DATABASE_URL` و`APP_PASSWORD` و`FRONTEND_ORIGIN` كمتغيرات سرية/بيئية.
- **Vercel:** اربط المستودع، واجعل Root Directory هي `react-app`، وأضف `VITE_API_URL` برابط Render مثل `https://your-api.onrender.com`.
- حدّث `FRONTEND_ORIGIN` في Render إلى رابط Vercel، ثم أعد نشر الـAPI.

انقل قاعدة PostgreSQL الحالية إلى Neon قبل النشر. ملفات `.env` مستثناة من Git لحماية بيانات الدخول.
