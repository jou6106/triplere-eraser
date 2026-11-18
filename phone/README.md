# Triple Re Mobile Eraser (ويندوز)

برنامج ويندوز بيمسح **الآيفون والآيباد والسامسونج وأي أندرويد**، ويرفع التقرير على الـ ERP علشان تطلع شهادة NIST SP 800-88.

## التسطيب
1. شغّل `TripleRe-Mobile-Eraser-Setup-x.y.z.exe`. بيعمل أيقونة على الديسكتوب.
2. **للآيفون والآيباد:** لازم يكون متسطب **Apple Devices**، ده مجاني من Microsoft Store. ممكن iTunes بداله. الـ Setup بيعرض يفتحه.
3. افتح البرنامج ودوس **استورد upload.conf**. الملف ده بيتعمل لكل كمبيوتر من صفحة **شهادات مسح البيانات** في الـ ERP: **إنشاء مفتاح** ← **تحميل upload.conf**.

## طريقة المسح
| الجهاز | الطريقة | المستوى |
|---|---|---|
| آيفون / آيباد (مفتوح أو مقفول بباسورد) | تثبيت آخر iOS موقّع من Apple مع مسح كامل من وضع Recovery | Purge (مسح تشفيري) |
| سامسونج / أندرويد مع USB debugging | Factory reset رسمي أوتوماتيك | Purge لو التخزين متشفّر |
| أندرويد مقفول | Wipe data / factory reset من الـ Recovery، والفني يأكّد | Purge لو متشفّر |

- **Find My وحساب Google/Samsung:** البرنامج بيقراهم ويحذّر، والفني لازم يوافق. القفل ده مش بيتشال بالمسح، وبيتكتب في الشهادة.
- **ملفات iOS:** بتتحمّل مرة واحدة لكل موديل في `C:\ProgramData\Triple Re\Mobile Eraser\firmware`. محتاج مساحة فاضية حوالي 2 × حجم الملف (من 6 لـ 9 جيجا).
- **التقارير:** بتتحفظ في `C:\ProgramData\Triple Re\Mobile Eraser\reports`. لو مفيش نت، بتترفع لوحدها بعدين.

## التطوير
- الكود في `src/` وهو Node من غير مكتبات. الشاشات في `ui/`.
- `node --test --test-concurrency=1 phone/tests/station.test.mjs` بيشغّل كل السيناريوهات على أجهزة وهمية و ERP وهمي.
- `node phone/tests/screens.mjs <folder>` بيصوّر كل الشاشات.
- البناء كله في GitHub Actions (`.github/workflows/phone.yml`):
  - أدوات الآيفون بتتبني من المصدر (MSYS2).
  - البرنامج بيتعمل exe واحد.
  - الـ Setup بيتعمل بـ Inno Setup.
  - البرنامج بيتسطّب ويتجرّب ويتشال على ويندوز.
