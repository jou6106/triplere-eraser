# Triple Re Eraser

نسخة Triple Re من [ShredOS](https://github.com/PartialVolume/shredos.x86_64) (nwipe 0.43.1 — NIST SP 800-88 Clear/Purge)، فيها:

- **واي فاي:** تعريفات كروت Intel و Qualcomm/Atheros و Realtek و MediaTek و Broadcom، وشاشة قبل المسح تختار منها الشبكة وتكتب الباسورد (أو تكمّل من غير نت). الشبكة اللي تحفظها بتتسجل على الفلاشة وكل اللابتوبات بعد كده بتتصل لوحدها.
- **جرد الهاردوير:** الرامات، البطارية، كروت الشبكة والشاشة والصوت، الكاميرا والبلوتوث — بيتحفظ في `nwipe_log_hwinventory_*.txt`.
- **رفع تلقائي للـ ERP** (HTTPS) بعد المسح: اللوج + الجرد + تقارير PDF. لو مفيش نت أو الرفع فشل، كل حاجة بتفضل على الفلاشة وترفعها يدوي.
- **الاسم في واجهة nwipe:** `Triple Re Eraser - ShredOS v…`

nwipe نفسه (المسح) ما اتعدّلش.

## البناء

البناء بيحصل أوتوماتيك على GitHub Actions مع كل push على `main` (أو يدوي من تبويب **Actions** ← **Build Triple Re Eraser** ← **Run workflow**). بياخد من ساعتين لـ 5 ساعات أول مرة، وأسرع بعد كده بسبب الـ cache.

الملف الجاهز: تبويب **Actions** ← آخر Run ناجح ← **Artifacts** ← `triplere-eraser-img`.

| الملف | الوظيفة |
|---|---|
| `apply.sh` | بيطبّق تعديلاتنا على سورس ShredOS (وبيوقف البناء لو أي تعديل ما لقاش مكانه) |
| `config/defconfig.fragment` | الباكدجات: wpa_supplicant, iw, dialog, curl + OpenSSL, firmware |
| `config/kernel.fragment` | تعريفات الواي فاي في الـ kernel |
| `overlay/` | سكريبتات Triple Re اللي بتتحط في النظام |
| `usb/` | الملفات اللي بتتنسخ على الفلاشة بعد الحرق |

## تجهيز الفلاشة

1. احرق ملف `.img` على الفلاشة بـ **balenaEtcher** أو **Rufus** (وضع DD).
2. افصل الفلاشة ورجّعها، وانسخ محتوى فولدر `usb/` على الفلاشة:
   - `etc/nwipe/logo.jpg` و `etc/nwipe/nwipe.conf` ← اللوجو وبيانات الشركة على تقرير nwipe (عدّل العنوان والتليفون في `nwipe.conf`).
   - `etc/triplere/upload.conf` ← اعمله من `upload.conf.example` وحط فيه مفتاح الفلاشة من الـ ERP.
3. اعمل Eject.

## اللي هيظهر على الشاشة

1. `Triple Re - collecting hardware inventory...` (جرد الهاردوير).
2. شاشة **Network**: لو فيه كابل نت أو شبكة محفوظة بيتصل لوحده. غير كده: **Connect to Wi-Fi** أو **Continue offline**. لو محدش داس حاجة 30 ثانية بيكمّل من غير نت.
3. واجهة nwipe بالاسم الجديد.
4. بعد المسح: شاشة بتقول التقارير اترفعت على الـ ERP ولا اتحفظت على الفلاشة.

> شاشات النظام بالإنجليزي لأن شاشة لينكس النصية مش بتعرض عربي.
