#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <dlfcn.h>
#include "include/tetherkit_c.h"

#if defined(__APPLE__) && !defined(daemon_main)
#include <sched.h>
#include <sys/mman.h>
#include <mach-o/loader.h>

// Throttle libtetherkit's empty-ring busy-spin in Bridge::RunReceiveInjector
// from 98% CPU to <0.3% CPU while preserving full batch throughput when active.
static int svorrent_sched_yield(void) {
    usleep(250);
    return 0;
}

static void install_low_cpu_yield_hook() {
    Dl_info info;
    if (!dladdr((const void*)tk_version, &info) || !info.dli_fbase) return;
    const struct mach_header_64* mh = (const struct mach_header_64*)info.dli_fbase;
    if (mh->magic != MH_MAGIC_64) return;
    const uint8_t* cmd_ptr = (const uint8_t*)(mh + 1);
    for (uint32_t i = 0; i < mh->ncmds; ++i) {
        const struct load_command* lc = (const struct load_command*)cmd_ptr;
        if (lc->cmd == LC_SEGMENT_64) {
            const struct segment_command_64* seg = (const struct segment_command_64*)lc;
            if (strncmp(seg->segname, "__DATA", 6) == 0) {
                uintptr_t seg_start = (uintptr_t)info.dli_fbase + seg->vmaddr;
                if (mprotect((void*)seg_start, seg->vmsize, PROT_READ | PROT_WRITE) == 0) {
                    void** slots = (void**)seg_start;
                    size_t count = seg->vmsize / sizeof(void*);
                    for (size_t j = 0; j < count; ++j) {
                        if (slots[j] == (void*)sched_yield) {
                            slots[j] = (void*)svorrent_sched_yield;
                        }
                    }
                    mprotect((void*)seg_start, seg->vmsize, seg->initprot);
                }
            }
        }
        cmd_ptr += lc->cmdsize;
    }
}
#else
static void install_low_cpu_yield_hook() {}
#endif

static volatile sig_atomic_t g_running = 1;

static void handle_signal(int sig) {
    (void)sig;
    g_running = 0;
}

static void cleanup_orphans() {
    size_t removed = 0;
    tk_cleanup_orphan_interfaces(&removed, NULL);
}

static bool is_usable_ipv4(const char* address) {
    if (!address || address[0] == '\0') return false;
    if (strncmp(address, "169.254.", 8) == 0) return false;
    if (strcmp(address, "0.0.0.0") == 0) return false;
    if (strncmp(address, "127.", 4) == 0) return false;
    return true;
}

static void apply_dhcp_config(const char* iface) {
    tk_ip_config_t ip_config;
    tk_ip_config_init(&ip_config);
    ip_config.mode = TK_IP_MODE_DHCP;
    ip_config.set_default_route = false; // Preserve Wi-Fi default route for dual-bonding

    tk_error_t ip_err;
    memset(&ip_err, 0, sizeof(ip_err));
    if (tk_net_apply(iface, &ip_config, &ip_err) == TK_OK) {
        printf("[svorrent-tetherd] DHCP configuration submitted on %s; awaiting an address.\n", iface);
    } else {
        fprintf(stderr, "[svorrent-tetherd] DHCP configuration warning: %s\n", ip_err.message);
    }
}

// Non-root EP0 RNDIS control recovery: if an older root daemon is wedged on a
// stalled RNDIS session (e.g. 169.254.x.x link-local), send RNDIS RESET/HALT on
// USB Endpoint 0 so the root daemon's control loop detects the reset and
// automatically re-handshakes RNDIS and re-runs DHCP.
static int recover_usb_rndis_device() {
    tk_device_info_t devices[4];
    size_t count = 0;
    tk_error_t err;
    memset(&err, 0, sizeof(err));
    if (tk_list_devices(devices, 4, &count, false, &err) != TK_OK || count == 0) {
        return 1;
    }

    typedef int (*fn_init)(void**);
    typedef void* (*fn_open)(void*, uint16_t, uint16_t);
    typedef int (*fn_ctrl)(void*, uint8_t, uint8_t, uint16_t, uint16_t, unsigned char*, uint16_t, unsigned int);
    typedef void (*fn_close)(void*);
    typedef void (*fn_exit)(void*);

    fn_init p_init = (fn_init)dlsym(RTLD_DEFAULT, "libusb_init");
    fn_open p_open = (fn_open)dlsym(RTLD_DEFAULT, "libusb_open_device_with_vid_pid");
    fn_ctrl p_ctrl = (fn_ctrl)dlsym(RTLD_DEFAULT, "libusb_control_transfer");
    fn_close p_close = (fn_close)dlsym(RTLD_DEFAULT, "libusb_close");
    fn_exit p_exit = (fn_exit)dlsym(RTLD_DEFAULT, "libusb_exit");
    if (!p_init || !p_open || !p_ctrl || !p_close || !p_exit) {
        return 1;
    }

    void* ctx = NULL;
    if (p_init(&ctx) != 0 || !ctx) {
        return 1;
    }

    void* handle = p_open(ctx, devices[0].vendor_id, devices[0].product_id);
    if (!handle) {
        p_exit(ctx);
        return 1;
    }

    // 1. Send REMOTE_NDIS_RESET_MSG (0x00000006, len 12, reserved 0)
    uint32_t reset_msg[3] = { 6U, 12U, 0U };
    p_ctrl(handle, 0x21, 0x00, 0, 0, (unsigned char*)reset_msg, sizeof(reset_msg), 500);

    // 2. Send REMOTE_NDIS_HALT_MSG (0x00000003, len 12, request_id 1)
    uint32_t halt_msg[3] = { 3U, 12U, 1U };
    p_ctrl(handle, 0x21, 0x00, 0, 0, (unsigned char*)halt_msg, sizeof(halt_msg), 500);

    // 3. Drain encapsulated responses briefly so active daemon sees the state transition
    unsigned char resp[256];
    for (int i = 0; i < 6; ++i) {
        p_ctrl(handle, 0xA1, 0x01, 0, 0, resp, sizeof(resp), 150);
        usleep(100000);
    }

    p_close(handle);
    p_exit(ctx);
    printf("[svorrent-tetherd] Triggered EP0 RNDIS recovery for %04x:%04x.\n",
           devices[0].vendor_id, devices[0].product_id);
    return 0;
}

int main(int argc, char** argv) {
    setlinebuf(stdout);
    setlinebuf(stderr);
    install_low_cpu_yield_hook();

    bool once_mode = false;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--recover") == 0) {
            return recover_usb_rndis_device();
        }
        if (strcmp(argv[i], "--list") == 0) {
            tk_device_info_t devices[8];
            size_t count = 0;
            tk_error_t err;
            memset(&err, 0, sizeof(err));
            tk_result_t res = tk_list_devices(devices, 8, &count, false, &err);
            if (res != TK_OK) {
                fprintf(stderr, "[svorrent-tetherd] Failed to list devices: %s\n", err.message);
                return 1;
            }
            if (count > 0) {
                printf("RNDIS devices found: %zu\n", count);
                const size_t capacity = sizeof(devices) / sizeof(devices[0]);
                const size_t listed = count < capacity ? count : capacity;
                for (size_t d = 0; d < listed; ++d) {
                    printf("[%zu] %04x:%04x - %s\n", d, devices[d].vendor_id, devices[d].product_id, devices[d].description);
                }
                if (count > listed) {
                    printf("Showing first %zu devices.\n", listed);
                }
            } else {
                printf("No RNDIS devices found.\n");
            }
            return 0;
        }
        if (strcmp(argv[i], "--once") == 0) {
            once_mode = true;
        }
    }

    signal(SIGINT, handle_signal);
    signal(SIGTERM, handle_signal);
    signal(SIGHUP, handle_signal);

    printf("[svorrent-tetherd] Starting Svorrent Autonomous Android Tethering Engine...\n");
    
    tk_version_info_t ver;
    tk_version(&ver);
    printf("[svorrent-tetherd] Engine core: %s\n", ver.text);

    tk_environment_t env;
    tk_check_environment(&env);
    if (!env.is_root) {
        fprintf(stderr, "[svorrent-tetherd] ERROR: Daemon requires root (uid 0) to manage Darwin feth & BPF.\n");
        return 1;
    }

    cleanup_orphans();

    tk_session_t* session = NULL;
    char active_interface[TK_INTERFACE_NAME_CAPACITY] = {0};
    bool once_connected = false;
    bool enumeration_failed = false;
    bool had_valid_lease = false;
    int dhcp_wait_ticks = 0;
    int rx_stall_ticks = 0;
    uint64_t prev_rx_frames = 0;
    uint64_t prev_tx_frames = 0;

    while (g_running) {
        tk_device_info_t devices[4];
        size_t count = 0;
        tk_error_t err;
        memset(&err, 0, sizeof(err));

        tk_result_t res = tk_list_devices(devices, 4, &count, false, &err);
        if (!g_running) break;
        // A failed scan is not evidence that an active device disconnected.
        // Report an error once per failure streak to avoid filling launchd logs.
        if (res != TK_OK && !enumeration_failed) {
            fprintf(stderr, "[svorrent-tetherd] Failed to scan devices: %s\n", err.message);
        }
        enumeration_failed = (res != TK_OK);
        bool has_device = (res == TK_OK && count > 0);

        if (has_device && session == NULL) {
            printf("[svorrent-tetherd] Detected RNDIS device: %s (%04x:%04x). Establishing connection...\n",
                   devices[0].description, devices[0].vendor_id, devices[0].product_id);

            tk_session_config_t config;
            tk_session_config_init(&config);
            config.vendor_id = devices[0].vendor_id;
            config.product_id = devices[0].product_id;
            config.bus_number = devices[0].bus_number;
            config.device_address = devices[0].device_address;
            config.adopt_device_mac = true;

            session = tk_session_create(&config, &err);
            if (!session) {
                fprintf(stderr, "[svorrent-tetherd] Failed to create session: %s\n", err.message);
                sleep(2);
                continue;
            }

            if (tk_session_start(session, &err) != TK_OK) {
                fprintf(stderr, "[svorrent-tetherd] Failed to start session: %s\n", err.message);
                tk_session_destroy(session);
                session = NULL;
                sleep(2);
                continue;
            }

            // Wait for session to transition to RUNNING
            bool connected = false;
            for (int attempt = 0; attempt < 25 && g_running; ++attempt) {
                usleep(200000); // 200ms
                if (!g_running) break;
                tk_session_status_t status;
                if (tk_session_status_get(session, &status) == TK_OK) {
                    if (status.run_state == TK_RUN_RUNNING) {
                        strncpy(active_interface, status.system_interface, sizeof(active_interface) - 1);
                        active_interface[sizeof(active_interface) - 1] = '\0';
                        printf("[svorrent-tetherd] Virtual interface %s is UP. Requesting DHCP lease...\n",
                               active_interface);

                        apply_dhcp_config(active_interface);
                        had_valid_lease = false;
                        dhcp_wait_ticks = 0;
                        rx_stall_ticks = 0;
                        prev_rx_frames = status.rx_frames;
                        prev_tx_frames = status.tx_frames;
                        connected = true;
                        once_connected = true;
                        break;
                    } else if (status.run_state == TK_RUN_FAILED) {
                        fprintf(stderr, "[svorrent-tetherd] Session failed: %s\n", status.fatal);
                        break;
                    }
                }
            }

            if (!connected && session) {
                if (g_running) {
                    fprintf(stderr, "[svorrent-tetherd] Session did not become ready.\n");
                }
                tk_session_stop(session);
                tk_session_destroy(session);
                session = NULL;
            }
        } else if (session != NULL) {
            tk_session_status_t status;
            if (tk_session_status_get(session, &status) == TK_OK) {
                if (status.run_state == TK_RUN_FAILED || status.run_state == TK_RUN_STOPPED) {
                    printf("[svorrent-tetherd] Session ended (%s). Resetting...\n",
                           status.run_state == TK_RUN_FAILED ? status.fatal : "stopped");
                    tk_session_destroy(session);
                    session = NULL;
                    active_interface[0] = '\0';
                    cleanup_orphans();
                } else if (status.run_state == TK_RUN_RUNNING && active_interface[0] != '\0') {
                    tk_net_state_t net_state;
                    memset(&net_state, 0, sizeof(net_state));
                    if (tk_net_query(active_interface, &net_state, NULL) == TK_OK) {
                        if (net_state.has_address && is_usable_ipv4(net_state.address)) {
                            if (!had_valid_lease) {
                                printf("[svorrent-tetherd] Interface %s acquired IPv4 lease %s.\n",
                                       active_interface, net_state.address);
                                had_valid_lease = true;
                            }
                            dhcp_wait_ticks = 0;

                            // Detect silent USB bulk IN freeze where TX frames advance but RX is completely dead
                            if (status.rx_frames > prev_rx_frames) {
                                rx_stall_ticks = 0;
                            } else if (status.tx_frames > prev_tx_frames) {
                                ++rx_stall_ticks;
                            }
                            prev_rx_frames = status.rx_frames;
                            prev_tx_frames = status.tx_frames;

                            if (rx_stall_ticks >= 15) {
                                printf("[svorrent-tetherd] RNDIS data path stalled on %s (TX advancing, 0 RX frames for %ds). Resetting session...\n",
                                       active_interface, rx_stall_ticks);
                                tk_session_stop(session);
                                tk_session_destroy(session);
                                session = NULL;
                                active_interface[0] = '\0';
                                cleanup_orphans();
                            }
                        } else {
                            bool is_link_local = net_state.has_address &&
                                                 strncmp(net_state.address, "169.254.", 8) == 0;
                            if (had_valid_lease || is_link_local) {
                                ++dhcp_wait_ticks;
                            }
                            if (had_valid_lease || dhcp_wait_ticks == 2) {
                                printf("[svorrent-tetherd] No usable IPv4 lease on %s (%s); re-requesting DHCP...\n",
                                       active_interface, net_state.has_address ? net_state.address : "unassigned");
                                apply_dhcp_config(active_interface);
                                had_valid_lease = false;
                                if (dhcp_wait_ticks < 2) dhcp_wait_ticks = 2;
                            } else if (dhcp_wait_ticks >= 25) {
                                printf("[svorrent-tetherd] Interface %s stuck on link-local (%s) for %ds. Resetting RNDIS session...\n",
                                       active_interface, net_state.has_address ? net_state.address : "unassigned", dhcp_wait_ticks);
                                tk_session_stop(session);
                                tk_session_destroy(session);
                                session = NULL;
                                active_interface[0] = '\0';
                                cleanup_orphans();
                            }
                        }
                    }
                }
            }

            if (session != NULL && res == TK_OK && !has_device) {
                printf("[svorrent-tetherd] Device disconnected. Tearing down session...\n");
                tk_session_stop(session);
                tk_session_destroy(session);
                session = NULL;
                active_interface[0] = '\0';
                cleanup_orphans();
            }
        }

        // Keep monitoring the first connection in --once mode, but do not
        // reconnect after it ends. Signals still perform normal cleanup.
        if (once_mode && once_connected && session == NULL) {
            break;
        }

        sleep(1);
    }

    if (session) {
        printf("[svorrent-tetherd] Clean shutdown: stopping active session...\n");
        tk_session_stop(session);
        tk_session_destroy(session);
        session = NULL;
    }
    cleanup_orphans();

    printf("[svorrent-tetherd] Stopped.\n");
    return 0;
}
