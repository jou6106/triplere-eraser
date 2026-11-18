/*
 * triplere-recovery-list: prints every iPhone/iPad attached in Recovery or DFU mode, one per line:
 *   ECID=0x... MODE=recovery|dfu CPID=0x.... BDID=0x.. SRNM=<serial> IMEI=<imei> PRODUCT=<iPhoneX,Y>
 * Used by Triple Re Mobile Eraser to follow several devices at once (identity of locked devices
 * comes from here). Links against libirecovery (LGPL-2.1).
 */
#include <stdio.h>
#include <string.h>
#include <libirecovery.h>
#ifdef _WIN32
#include <windows.h>
#define sleep_ms(x) Sleep(x)
#else
#include <unistd.h>
#define sleep_ms(x) usleep((x) * 1000)
#endif

static const char *product_for(unsigned int cpid, unsigned int bdid)
{
	irecv_device_t all = irecv_devices_get_all();
	for (int i = 0; all && all[i].product_type; i++) {
		if (all[i].chip_id == cpid && all[i].board_id == bdid) return all[i].product_type;
	}
	return "";
}

static void on_event(const irecv_device_event_t *ev, void *user)
{
	(void)user;
	if (ev->type != IRECV_DEVICE_ADD || !ev->device_info || !ev->device_info->ecid) return;
	const struct irecv_device_info *di = ev->device_info;
	int m = (int)ev->mode;
	const char *mode = (m == 0x1227 || m == 0x1222 || m == 0xf014) ? "dfu" : "recovery";
	printf("ECID=0x%016llX MODE=%s CPID=0x%04X BDID=0x%02X SRNM=%s IMEI=%s PRODUCT=%s\n",
		(unsigned long long)di->ecid, mode, di->cpid, di->bdid,
		di->srnm ? di->srnm : "", di->imei ? di->imei : "", product_for(di->cpid, di->bdid));
	fflush(stdout);
}

int main(int argc, char **argv)
{
	if (argc > 1 && (!strcmp(argv[1], "-h") || !strcmp(argv[1], "--help"))) {
		printf("Usage: triplere-recovery-list\nLists iPhone/iPad devices in Recovery or DFU mode.\n");
		return 0;
	}
	irecv_device_event_context_t ctx = NULL;
	if (irecv_device_event_subscribe(&ctx, on_event, NULL) != IRECV_E_SUCCESS) {
		fprintf(stderr, "cannot watch USB devices\n");
		return 1;
	}
	/* Devices already attached are reported right after subscribing. */
	sleep_ms(1500);
	irecv_device_event_unsubscribe(ctx);
	return 0;
}
