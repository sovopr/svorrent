// Svorrent Native macOS Cocoa Application Launcher
// Keeps Svorrent active on the macOS Dock as a native background application,
// manages the Node.js backend daemon, and opens/focuses the web interface in the browser.

#import <Cocoa/Cocoa.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <arpa/inet.h>
#import <unistd.h>

static BOOL isServerListening(int port) {
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) return NO;

    struct timeval tv;
    tv.tv_sec = 0;
    tv.tv_usec = 250000; // 250ms timeout
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tv, sizeof(tv));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");

    int res = connect(sock, (struct sockaddr*)&addr, sizeof(addr));
    close(sock);
    return (res == 0);
}

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property (nonatomic, strong) NSTask *backendTask;
@property (nonatomic, copy) NSString *webUrl;
@end

@implementation AppDelegate

- (instancetype)init {
    self = [super init];
    if (self) {
        _webUrl = @"http://localhost:3001";
    }
    return self;
}

- (NSString *)findNodeBinary {
    NSBundle *bundle = [NSBundle mainBundle];
    NSString *bundledNode = [bundle pathForResource:@"node" ofType:nil inDirectory:nil];
    if (bundledNode && [[NSFileManager defaultManager] isExecutableFileAtPath:bundledNode]) {
        return bundledNode;
    }

    NSString *macOSNode = [[bundle.bundlePath stringByAppendingPathComponent:@"Contents/MacOS"] stringByAppendingPathComponent:@"node"];
    if ([[NSFileManager defaultManager] isExecutableFileAtPath:macOSNode]) {
        return macOSNode;
    }

    NSArray *candidates = @[
        @"/opt/homebrew/bin/node",
        @"/usr/local/bin/node",
        @"/usr/bin/node"
    ];
    for (NSString *path in candidates) {
        if ([[NSFileManager defaultManager] isExecutableFileAtPath:path]) {
            return path;
        }
    }
    return @"/opt/homebrew/bin/node";
}

- (NSString *)findBackendScript {
    NSBundle *bundle = [NSBundle mainBundle];
    NSString *bundleBackend = [bundle.resourcePath stringByAppendingPathComponent:@"app/backend/server.js"];
    if ([[NSFileManager defaultManager] fileExistsAtPath:bundleBackend]) {
        return bundleBackend;
    }

    // Fallback for development / direct repository invocation
    NSString *repoBackend = @"/Users/soveet/svorrent/backend/server.js";
    if ([[NSFileManager defaultManager] fileExistsAtPath:repoBackend]) {
        return repoBackend;
    }
    return nil;
}

- (NSString *)bundleCommit {
    NSBundle *bundle = [NSBundle mainBundle];
    NSString *infoPath = [bundle.resourcePath stringByAppendingPathComponent:@"app/backend/build-info.json"];
    if (![[NSFileManager defaultManager] fileExistsAtPath:infoPath]) {
        infoPath = @"/Users/soveet/svorrent/backend/build-info.json";
    }
    if (![[NSFileManager defaultManager] fileExistsAtPath:infoPath]) {
        return nil;
    }
    NSData *data = [NSData dataWithContentsOfFile:infoPath];
    if (!data) return nil;
    NSError *err = nil;
    id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
    if ([json isKindOfClass:[NSDictionary class]] && [json[@"commit"] isKindOfClass:[NSString class]]) {
        return [json[@"commit"] lowercaseString];
    }
    return nil;
}

- (NSString *)bundleVersion {
    NSBundle *bundle = [NSBundle mainBundle];
    NSString *pkgPath = [bundle.resourcePath stringByAppendingPathComponent:@"app/backend/package.json"];
    if (![[NSFileManager defaultManager] fileExistsAtPath:pkgPath]) {
        pkgPath = @"/Users/soveet/svorrent/backend/package.json";
    }
    if (![[NSFileManager defaultManager] fileExistsAtPath:pkgPath]) {
        return nil;
    }
    NSData *data = [NSData dataWithContentsOfFile:pkgPath];
    if (!data) return nil;
    NSError *err = nil;
    id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
    if ([json isKindOfClass:[NSDictionary class]] && [json[@"version"] isKindOfClass:[NSString class]]) {
        return json[@"version"];
    }
    return nil;
}

- (NSDictionary *)fetchRunningBackendStatus {
    NSURL *url = [NSURL URLWithString:@"http://127.0.0.1:3001/api/updater/status"];
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url
                                                       cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                                   timeoutInterval:1.0];
    __block NSDictionary *result = nil;
    dispatch_semaphore_t sema = dispatch_semaphore_create(0);
    NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithRequest:req
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            if (!error && data && [(NSHTTPURLResponse *)response statusCode] == 200) {
                NSError *jsonErr = nil;
                id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonErr];
                if ([json isKindOfClass:[NSDictionary class]]) {
                    result = (NSDictionary *)json;
                }
            }
            dispatch_semaphore_signal(sema);
        }];
    [task resume];
    dispatch_semaphore_wait(sema, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.2 * NSEC_PER_SEC)));
    return result;
}

- (BOOL)isExistingBackendOutdated {
    if (!isServerListening(3001)) {
        return NO;
    }

    NSDictionary *status = [self fetchRunningBackendStatus];
    if (!status) {
        NSLog(@"[Svorrent] Port 3001 is listening but not responding to updater status. Considering outdated/unresponsive.");
        return YES;
    }

    NSString *runningCommit = [status[@"currentCommit"] isKindOfClass:[NSString class]] ? [status[@"currentCommit"] lowercaseString] : nil;
    NSString *runningVersion = [status[@"currentVersion"] isKindOfClass:[NSString class]] ? status[@"currentVersion"] : nil;

    NSString *expectedCommit = [self bundleCommit];
    NSString *expectedVersion = [self bundleVersion];

    if (expectedCommit.length > 0 && runningCommit.length > 0) {
        if (![expectedCommit isEqualToString:runningCommit]) {
            NSLog(@"[Svorrent] Running backend commit mismatch (running: %@, bundle: %@). Needs replacement.", runningCommit, expectedCommit);
            return YES;
        }
    }

    if (expectedVersion.length > 0 && runningVersion.length > 0) {
        if (![expectedVersion isEqualToString:runningVersion]) {
            NSLog(@"[Svorrent] Running backend version mismatch (running: %@, bundle: %@). Needs replacement.", runningVersion, expectedVersion);
            return YES;
        }
    }

    return NO;
}

- (void)startBackendIfNeeded {
    if (isServerListening(3001)) {
        if ([self isExistingBackendOutdated]) {
            NSLog(@"[Svorrent] Stale backend detected on port 3001. Terminating old process...");
            killBackendProcess(self.backendTask);
            for (int i = 0; i < 20; i++) {
                if (!isServerListening(3001)) break;
                usleep(100000);
            }
        } else {
            NSLog(@"[Svorrent] Healthy and matching backend is already running on port 3001.");
            return;
        }
    }

    NSString *nodeBin = [self findNodeBinary];
    NSString *backendScript = [self findBackendScript];

    if (!backendScript) {
        NSLog(@"[Svorrent] Could not locate backend server.js");
        return;
    }

    self.backendTask = [[NSTask alloc] init];
    self.backendTask.launchPath = nodeBin;
    self.backendTask.arguments = @[
        @"--openssl-legacy-provider",
        backendScript
    ];
    self.backendTask.currentDirectoryPath = [backendScript stringByDeletingLastPathComponent];

    // Redirect logs to ~/Library/Logs/Svorrent/svorrent.log
    NSString *logDir = [@"~/Library/Logs/Svorrent" stringByExpandingTildeInPath];
    [[NSFileManager defaultManager] createDirectoryAtPath:logDir withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *logPath = [logDir stringByAppendingPathComponent:@"svorrent.log"];
    [[NSFileManager defaultManager] createFileAtPath:logPath contents:nil attributes:nil];
    NSFileHandle *logHandle = [NSFileHandle fileHandleForWritingAtPath:logPath];

    if (logHandle) {
        [logHandle seekToEndOfFile];
        self.backendTask.standardOutput = logHandle;
        self.backendTask.standardError = logHandle;
    }

    @try {
        [self.backendTask launch];
        NSLog(@"[Svorrent] Spawned backend daemon (PID: %d)", self.backendTask.processIdentifier);
    } @catch (NSException *e) {
        NSLog(@"[Svorrent] Failed to launch backend: %@", e);
    }

    // Wait up to 3 seconds for backend port to listen
    for (int i = 0; i < 30; i++) {
        if (isServerListening(3001)) break;
        usleep(100000); // 100ms
    }
}

- (void)setupMainMenu {
    NSMenu *mainMenu = [[NSMenu alloc] init];
    NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:appMenuItem];

    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"Svorrent"];
    [appMenu addItemWithTitle:@"About Svorrent" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Open Svorrent Web" action:@selector(openWebInterface:) keyEquivalent:@"o"];
    [appMenu addItemWithTitle:@"Open Downloads Folder" action:@selector(openDownloadsFolder:) keyEquivalent:@"d"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Hide Svorrent" action:@selector(hide:) keyEquivalent:@"h"];
    [appMenu addItemWithTitle:@"Hide Others" action:@selector(hideOtherApplications:) keyEquivalent:@"h"];
    [[appMenu itemAtIndex:appMenu.numberOfItems - 1] setKeyEquivalentModifierMask:(NSEventModifierFlagOption | NSEventModifierFlagCommand)];
    [appMenu addItemWithTitle:@"Show All" action:@selector(unhideAllApplications:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Quit Svorrent" action:@selector(terminate:) keyEquivalent:@"q"];

    [appMenuItem setSubmenu:appMenu];
    [NSApp setMainMenu:mainMenu];
}

- (void)ensureTetherHelperUpToDate {
    NSBundle *bundle = [NSBundle mainBundle];
    NSString *bundledBin = [bundle.resourcePath stringByAppendingPathComponent:@"app/backend/bin/svorrent-tetherd"];
    NSString *installerScript = [bundle.resourcePath stringByAppendingPathComponent:@"app/backend/scripts/install-tetherd.sh"];
    if (![[NSFileManager defaultManager] isExecutableFileAtPath:bundledBin] ||
        ![[NSFileManager defaultManager] fileExistsAtPath:installerScript]) {
        bundledBin = @"/Users/soveet/svorrent/backend/bin/svorrent-tetherd";
        installerScript = @"/Users/soveet/svorrent/backend/scripts/install-tetherd.sh";
    }
    if (![[NSFileManager defaultManager] isExecutableFileAtPath:bundledBin] ||
        ![[NSFileManager defaultManager] fileExistsAtPath:installerScript]) {
        return;
    }

    NSString *installedBin = @"/Library/PrivilegedHelperTools/com.svorrent.tetherd/svorrent-tetherd";
    if (![[NSFileManager defaultManager] isExecutableFileAtPath:installedBin] ||
        [[NSFileManager defaultManager] contentsEqualAtPath:bundledBin andPath:installedBin]) {
        return;
    }

    NSTask *task = [[NSTask alloc] init];
    task.launchPath = @"/usr/bin/osascript";
    NSString *appleScript = [NSString stringWithFormat:
        @"do shell script \"/bin/bash '%@'\" with administrator privileges",
        [installerScript stringByReplacingOccurrencesOfString:@"'" withString:@"'\\''"]];
    task.arguments = @[@"-e", appleScript];
    @try {
        [task launch];
        [task waitUntilExit];
    } @catch (NSException *e) {
        NSLog(@"[Svorrent] Tether helper update skipped: %@", e);
    }
}

- (void)applicationDidFinishLaunching:(NSNotification *)aNotification {
    NSString *bundlePath = [[NSBundle mainBundle] bundlePath];
    if ([bundlePath hasPrefix:@"/Volumes/"] || [bundlePath containsString:@"/AppTranslocation/"]) {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"Install Svorrent First";
        alert.informativeText = @"Please drag Svorrent to your Applications folder, then launch it from Applications.";
        [alert addButtonWithTitle:@"OK"];
        [alert runModal];
        [NSApp terminate:nil];
        return;
    }

    [self setupMainMenu];
    [self ensureTetherHelperUpToDate];
    [self startBackendIfNeeded];
    [self openWebInterface:nil];
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    // When user clicks Svorrent in the Dock, bring web app to front
    [self openWebInterface:nil];
    return YES;
}

- (IBAction)openWebInterface:(id)sender {
    [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:self.webUrl]];
}

- (IBAction)openDownloads:(id)sender {
    [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:@"http://localhost:3001/#/downloads"]];
}

- (IBAction)openNetworks:(id)sender {
    [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:@"http://localhost:3001/#/networks"]];
}

- (IBAction)openDownloadsFolder:(id)sender {
    NSString *downloadsDir = [@"~/Downloads/Svorrent" stringByExpandingTildeInPath];
    [[NSFileManager defaultManager] createDirectoryAtPath:downloadsDir withIntermediateDirectories:YES attributes:nil error:nil];
    [[NSWorkspace sharedWorkspace] openURL:[NSURL fileURLWithPath:downloadsDir isDirectory:YES]];
}

- (NSMenu *)applicationDockMenu:(NSApplication *)sender {
    NSMenu *dockMenu = [[NSMenu alloc] initWithTitle:@"Svorrent Dock Menu"];

    NSMenuItem *openItem = [[NSMenuItem alloc] initWithTitle:@"Open Svorrent Web"
                                                      action:@selector(openWebInterface:)
                                               keyEquivalent:@""];
    [openItem setTarget:self];
    [dockMenu addItem:openItem];

    [dockMenu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *downloadsItem = [[NSMenuItem alloc] initWithTitle:@"Downloads"
                                                           action:@selector(openDownloads:)
                                                    keyEquivalent:@""];
    [downloadsItem setTarget:self];
    [dockMenu addItem:downloadsItem];

    NSMenuItem *networksItem = [[NSMenuItem alloc] initWithTitle:@"Networks"
                                                          action:@selector(openNetworks:)
                                                   keyEquivalent:@""];
    [networksItem setTarget:self];
    [dockMenu addItem:networksItem];

    NSMenuItem *folderItem = [[NSMenuItem alloc] initWithTitle:@"Open Downloads Folder in Finder"
                                                        action:@selector(openDownloadsFolder:)
                                                 keyEquivalent:@""];
    [folderItem setTarget:self];
    [dockMenu addItem:folderItem];

    return dockMenu;
}

static void killBackendProcess(NSTask *task) {
    if (task && [task isRunning]) {
        [task terminate];
    }
    // Attempt graceful SIGTERM first
    NSTask *termTask = [[NSTask alloc] init];
    termTask.launchPath = @"/bin/sh";
    termTask.arguments = @[@"-c", @"lsof -ti :3001 | xargs kill -15 2>/dev/null"];
    @try {
        [termTask launch];
        [termTask waitUntilExit];
    } @catch (NSException *e) {}

    // Wait up to 1.5 seconds for port to clear
    for (int i = 0; i < 15; i++) {
        if (!isServerListening(3001)) break;
        usleep(100000); // 100ms
    }

    // Force SIGKILL if port is still listening
    if (isServerListening(3001)) {
        NSTask *killTask = [[NSTask alloc] init];
        killTask.launchPath = @"/bin/sh";
        killTask.arguments = @[@"-c", @"lsof -ti :3001 | xargs kill -9 2>/dev/null"];
        @try {
            [killTask launch];
            [killTask waitUntilExit];
        } @catch (NSException *e) {}
    }

    // Clean up launchd job if any
    uid_t uid = getuid();
    NSString *jobTarget = [NSString stringWithFormat:@"gui/%d/com.sovopr.svorrent.backend", uid];
    NSTask *bootout = [[NSTask alloc] init];
    bootout.launchPath = @"/bin/launchctl";
    bootout.arguments = @[@"bootout", jobTarget];
    @try { [bootout launch]; [bootout waitUntilExit]; } @catch (NSException *e) {}
}

- (void)applicationWillTerminate:(NSNotification *)aNotification {
    NSLog(@"[Svorrent] Terminating backend daemon...");
    killBackendProcess(self.backendTask);
}

@end

int main(int argc, const char * argv[]) {
    (void)argc;
    (void)argv;
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        [app setDelegate:delegate];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        [app run];
    }
    return 0;
}

