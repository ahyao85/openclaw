package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayChannelsSummary
import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayCronJobSummary
import ai.openclaw.app.GatewayDreamingSummary
import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.GatewaySkillSummary
import ai.openclaw.app.GatewaySkillWorkshopSummary
import ai.openclaw.app.GatewaySummaryState
import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.R
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.currentAppLanguage
import ai.openclaw.app.firstGraphemeOrNull
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.joinedNativeText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeTextResource
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.resolveAgentIdFromMainSessionKey
import ai.openclaw.app.systemagent.SystemAgentChatAccess
import ai.openclaw.app.ui.design.AgentAvatarSource
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawListItem
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSeparatedColumn
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.agentAvatarSource
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.window.layout.DisplayFeature
import kotlinx.coroutines.launch
import java.util.Locale

internal enum class Tab {
  Overview,
  Chat,
  Sessions,
  Settings,
  ProvidersModels,
  Files,
  Dashboard,
}

private val shellContentInsets: WindowInsets
  @Composable get() = WindowInsets.safeDrawing

/** Main post-onboarding shell that owns top-level Android navigation state. */
@Composable
fun ShellScreen(
  viewModel: MainViewModel,
  modifier: Modifier = Modifier,
  features: List<DisplayFeature> = emptyList(),
) {
  val appearanceThemeMode by viewModel.appearanceThemeMode.collectAsState()
  val appearanceThemeFamily by viewModel.appearanceThemeFamily.collectAsState()
  val appearanceAccentArgb by viewModel.appearanceAccentArgb.collectAsState()
  val gatewayAccentArgb by viewModel.gatewayAccentArgb.collectAsState()
  val shellDark = appearanceThemeMode.isDark(systemDark = isSystemInDarkTheme())
  OpenClawSystemBarAppearance(lightAppearance = !shellDark)
  ClawDesignTheme(dark = shellDark, family = appearanceThemeFamily, accentArgb = appearanceAccentArgb ?: gatewayAccentArgb) {
    val nav = rememberSaveable(saver = ShellNavigation.Saver) { ShellNavigation() }
    var commandOpen by rememberSaveable { mutableStateOf(false) }
    var conversationScreenWasActive by rememberSaveable { mutableStateOf(false) }
    val pendingTrust by viewModel.pendingGatewayTrust.collectAsState()
    val gatewayAddition by viewModel.gatewayAdditionRequest.collectAsState()
    FoldAwareContent(
      features = features,
      modifier = modifier.background(ClawTheme.colors.canvas),
      bookPanesEnabled = !commandOpen && pendingTrust == null,
      tabletopEnabled = nav.activeTab == Tab.Chat && !commandOpen && pendingTrust == null,
    ) { foldBounds ->
      val bookPanes = foldBounds.book
      val permanentSidebar = bookPanes != null
      // Mode changes discard modal operations and their drag state, not the two content slots.
      val sidebarDrawerState = key(permanentSidebar) { rememberDrawerState(initialValue = DrawerValue.Closed) }
      var sidebarRowDragging by remember(sidebarDrawerState) { mutableStateOf(false) }
      val drawerScope = key(sidebarDrawerState) { rememberCoroutineScope() }
      val openSidebar: () -> Unit = {
        if (!permanentSidebar) drawerScope.launch { sidebarDrawerState.open() }
      }
      val closeSidebar: () -> Unit = {
        if (!permanentSidebar) drawerScope.launch { sidebarDrawerState.close() }
      }
      val requestedHomeDestination by viewModel.requestedHomeDestination.collectAsState()
      val runtimeInitialized by viewModel.runtimeInitialized.collectAsState()
      val gatewayAgents by viewModel.gatewayAgents.collectAsState()
      val gatewayDefaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()
      val chatSessionOwnerAgentId by viewModel.chatSessionOwnerAgentId.collectAsState()
      val chatSessions by viewModel.chatSessions.collectAsState()
      val chatSessionKey by viewModel.chatSessionKey.collectAsState()
      val gatewayConnectionDisplay by viewModel.gatewayConnectionDisplay.collectAsState()

      LaunchedEffect(requestedHomeDestination) {
        val destination = requestedHomeDestination ?: return@LaunchedEffect
        // HomeDestination is a one-shot command from launch intents and settings
        // actions; consume it after translating to local shell state.
        nav.selectTab(
          when (destination) {
            HomeDestination.Connect -> Tab.Overview
            HomeDestination.Chat -> Tab.Chat
            HomeDestination.Voice -> Tab.Chat
            HomeDestination.Settings -> Tab.Settings
          },
        )
        // Screenshot scenes can target a settings detail route alongside the tab.
        viewModel.requestedSettingsRoute.value?.let { route ->
          nav.openSettingsRoute(route)
          viewModel.clearRequestedSettingsRoute()
        }
        closeSidebar()
        viewModel.clearRequestedHomeDestination()
      }

      LaunchedEffect(nav.activeTab, runtimeInitialized) {
        val conversationScreenActive = nav.activeTab == Tab.Chat
        if (conversationScreenActive || conversationScreenWasActive || runtimeInitialized) {
          viewModel.setVoiceScreenActive(conversationScreenActive)
        }
        conversationScreenWasActive = conversationScreenActive
      }

      BackHandler(
        enabled =
          (
            permanentSidebar ||
              (
                sidebarDrawerState.currentValue == DrawerValue.Closed &&
                  sidebarDrawerState.targetValue == DrawerValue.Closed
              )
          ) &&
            nav.activeTab != Tab.Overview,
      ) {
        nav.back()
      }

      BackHandler(enabled = commandOpen) {
        commandOpen = false
      }

      LaunchedEffect(commandOpen, pendingTrust, sidebarDrawerState) {
        if (commandOpen || pendingTrust != null) closeSidebar()
      }

      val activeSidebarDestination =
        when {
          nav.activeTab == Tab.Settings && nav.settingsRoute != SettingsRoute.Skills -> SidebarDestination.Settings
          nav.activeTab == Tab.Overview -> SidebarDestination.Work
          nav.activeTab == Tab.Chat -> SidebarDestination.Home
          nav.activeTab == Tab.Settings && nav.settingsRoute == SettingsRoute.Skills -> SidebarDestination.Skills
          nav.activeTab == Tab.Sessions -> SidebarDestination.Threads
          else -> null
        }
      val selectSidebarDestination: (SidebarDestination) -> Unit = { destination ->
        when (destination) {
          SidebarDestination.Settings -> {
            nav.openSettingsRoute(SettingsRoute.Home)
          }

          SidebarDestination.Work -> {
            nav.selectTab(Tab.Overview)
          }

          SidebarDestination.Home -> {
            viewModel.openMainChat()
            nav.selectTab(Tab.Chat)
          }

          SidebarDestination.Skills -> {
            nav.openSettingsRoute(SettingsRoute.Skills)
          }

          SidebarDestination.Threads -> {
            nav.selectTab(Tab.Sessions)
          }
        }
        closeSidebar()
      }

      Box(modifier = Modifier.fillMaxSize().background(ClawTheme.colors.canvas)) {
        SidebarNavigationShell(
          drawerState = sidebarDrawerState,
          bookPanes = bookPanes,
          sidebarBand = foldBounds.sidebarBand,
          gesturesEnabled = !sidebarRowDragging,
          drawerContent = {
            OpenClawSidebar(
              viewModel = viewModel,
              rowHostBand = foldBounds.sidebarBand,
              agents = gatewayAgents,
              selectedAgentId = chatSessionOwnerAgentId ?: gatewayDefaultAgentId,
              sessions = chatSessions,
              activeSessionKey = chatSessionKey,
              activeDestination = activeSidebarDestination,
              connection = gatewayConnectionDisplay,
              visible =
                !commandOpen && pendingTrust == null &&
                  (permanentSidebar || sidebarDrawerState.isOpen || sidebarDrawerState.targetValue == DrawerValue.Open),
              showCloseButton = !permanentSidebar,
              onClose = closeSidebar,
              onDragActiveChange = { sidebarRowDragging = it },
              onNewSession = {
                viewModel.startNewChat(worktree = false)
                nav.selectTab(Tab.Chat)
                closeSidebar()
              },
              onSelectAgent = { agentId ->
                viewModel.selectChatAgent(agentId)
                nav.selectTab(Tab.Chat)
                closeSidebar()
              },
              onSelectSession = { session ->
                viewModel.switchChatSession(session.key, session.ownerAgentId)
                nav.selectTab(Tab.Chat)
                closeSidebar()
              },
              onSelectCatalogSession = { session ->
                viewModel.continueSessionCatalogEntry(session) { continued ->
                  if (continued) {
                    nav.selectTab(Tab.Chat)
                    closeSidebar()
                  }
                }
              },
              onCreateCatalogSession = { catalogId ->
                nav.selectTab(Tab.Chat)
                closeSidebar()
                viewModel.createSessionCatalogEntry(catalogId)
              },
              onSelectDestination = selectSidebarDestination,
            )
          },
        ) {
          when (nav.activeTab) {
            Tab.Overview -> {
              OverviewScreen(
                viewModel = viewModel,
                showSidebarButton = !permanentSidebar,
                onOpenSidebar = openSidebar,
                onSelectTab = nav::selectTab,
                onOpenSettingsRoute = nav::openSettingsRoute,
                onOpenCommand = { commandOpen = true },
              )
            }

            Tab.Chat -> {
              UnifiedChatShellScreen(
                viewModel = viewModel,
                tabletopPanes = foldBounds.tabletop,
                features = features,
                showSidebarButton = !permanentSidebar,
                onOpenSidebar = openSidebar,
                onOpenDashboard = nav::openSessionDashboard,
                onOpenGatewaySettings = { nav.openSettingsRoute(SettingsRoute.Gateway) },
                onOpenProvidersModels = { nav.openDetailTab(Tab.ProvidersModels) },
              )
            }

            Tab.ProvidersModels -> {
              ProvidersModelsScreen(
                viewModel = viewModel,
                onBack = nav::back,
              )
            }

            Tab.Sessions -> {
              SessionsScreen(
                viewModel = viewModel,
                showSidebarButton = !permanentSidebar,
                onOpenSidebar = openSidebar,
                onOpenChat = { nav.selectTab(Tab.Chat) },
              )
            }

            Tab.Files -> {
              WorkspaceFilesScreen(
                viewModel = viewModel,
                onBack = nav::back,
              )
            }

            Tab.Dashboard -> {
              SessionDashboardScreen(
                viewModel = viewModel,
                sessionKey = nav.dashboardSessionKey,
                onBack = nav::back,
              )
            }

            Tab.Settings -> {
              SettingsShellScreen(
                viewModel = viewModel,
                route = nav.settingsRoute,
                showSidebarButton = !permanentSidebar,
                onOpenSidebar = openSidebar,
                onRouteChange = nav::openSettingsRouteFromHome,
                onBack = nav::back,
                onOpenCommand = { commandOpen = true },
              )
            }
          }
        }

        if (commandOpen) {
          CommandPalette(
            viewModel = viewModel,
            onDismiss = { commandOpen = false },
            onOpen = { action ->
              when (action) {
                CommandAction.Chat, CommandAction.Voice -> {
                  nav.selectTab(Tab.Chat)
                }

                CommandAction.Sessions -> {
                  nav.openDetailTab(Tab.Sessions)
                }

                is CommandAction.Settings -> {
                  when {
                    // Keep the provider command on its standalone screen; entering
                    // Settings detail would also start the Home summary refreshes.
                    action.route == SettingsRoute.ProvidersModels -> nav.openDetailTab(Tab.ProvidersModels)

                    action.route != SettingsRoute.Home && nav.activeTab == Tab.Settings && nav.settingsRoute == SettingsRoute.Home -> nav.openSettingsRouteFromHome(action.route)

                    else -> nav.openSettingsRoute(action.route)
                  }
                }
              }
              commandOpen = false
            },
            onOpenSession = { sessionKey, ownerAgentId ->
              viewModel.switchChatSession(sessionKey, ownerAgentId)
              nav.selectTab(Tab.Chat)
              commandOpen = false
            },
          )
        }

        gatewayAddition?.let { request ->
          key(request) { GatewayAdditionDialog(viewModel, request) }
        }

        pendingTrust?.let { prompt ->
          // Gateway certificate trust is modal across the shell so navigation
          // cannot hide a changed TLS identity prompt.
          GatewayTrustDialog(
            prompt = prompt,
            confirmLabel = stringResource(R.string.trust_and_continue),
            cancelLabel = stringResource(R.string.cancel),
            onAccept = { viewModel.acceptGatewayTrustPrompt(prompt, it) },
            onUseSystemTrust = { viewModel.useSystemGatewayTrustPrompt(prompt) },
            onDecline = { viewModel.declineGatewayTrustPrompt(prompt) },
          )
        }
      }
    }
  }
}

internal fun localizedUppercase(
  value: String,
  languageTag: String?,
  fallbackLocale: Locale = Locale.getDefault(),
): String = value.uppercase(languageTag?.let(Locale::forLanguageTag) ?: fallbackLocale)

internal fun localizedInitial(
  value: String,
  languageTag: String?,
  fallbackLocale: Locale = Locale.getDefault(),
): String? = value.firstGraphemeOrNull()?.let { localizedUppercase(it, languageTag, fallbackLocale) }

internal fun overviewRecentSessions(
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String? = null,
  agentId: String? = null,
): List<ChatSessionEntry> =
  sessions
    .filter { session ->
      val owner = session.ownerAgentId ?: resolveAgentIdFromMainSessionKey(session.key)
      session.archived != true && session.isMain != true && (agentId == null || owner == null || owner == agentId) &&
        (mainSessionKey == null || (session.key != mainSessionKey && session.key != "main"))
    }.withIndex()
    .groupBy { entry -> entry.value.ownerAgentId to entry.value.key }
    .values
    .map { entries ->
      entries
        .sortedWith(
          compareByDescending<IndexedValue<ChatSessionEntry>> { entry -> entry.value.overviewRecentSessionRecencyMs() }
            .thenBy { entry -> entry.index },
        ).first()
    }.sortedWith(
      compareByDescending<IndexedValue<ChatSessionEntry>> { entry -> entry.value.overviewRecentSessionRecencyMs() }
        .thenBy { entry -> entry.value.key },
    ).map { entry -> entry.value }

private fun ChatSessionEntry.overviewRecentSessionRecencyMs(): Long = lastActivityAt ?: updatedAtMs ?: Long.MIN_VALUE

internal data class OverviewMetricCardSpec(
  val title: String,
  val value: String,
  val status: ClawStatus,
  val tab: Tab,
  val settingsRoute: SettingsRoute? = null,
  val progressFraction: Float? = null,
)

internal fun overviewMetricCardSpecs(
  nodesDevicesSummary: GatewayNodesDevicesSummary,
  pendingRunCount: Int,
  automationCount: Int,
  pendingApprovals: Int,
): List<OverviewMetricCardSpec> {
  val online = nodesDevicesSummary.nodes.count { it.connected }
  val total = nodesDevicesSummary.nodes.size
  return listOf(
    OverviewMetricCardSpec(nativeString("Runs"), pendingRunCount.toString(), ClawStatus.Neutral, Tab.Sessions),
    OverviewMetricCardSpec(nativeString("Automations"), automationCount.toString(), ClawStatus.Neutral, Tab.Settings, SettingsRoute.CronJobs),
    OverviewMetricCardSpec(
      nativeString("Devices"),
      nativeString("\$online/\$total", online, total),
      when {
        nodesDevicesSummary.pendingDevices.isNotEmpty() || nodesDevicesSummary.hasNodeCapabilityApprovalPending() -> ClawStatus.Warning
        online < total -> ClawStatus.Danger
        online > 0 -> ClawStatus.Success
        else -> ClawStatus.Neutral
      },
      Tab.Settings,
      SettingsRoute.NodesDevices,
      if (total > 0) online.toFloat() / total else null,
    ),
    OverviewMetricCardSpec(nativeString("Approvals"), pendingApprovals.toString(), if (pendingApprovals > 0) ClawStatus.Warning else ClawStatus.Neutral, Tab.Settings, SettingsRoute.Approvals),
  )
}

internal fun overviewAgentName(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
): String {
  val agent = overviewAgent(agents = agents, defaultAgentId = defaultAgentId)
  return agent?.name?.takeIf { it.isNotBlank() } ?: agent?.id?.takeIf { it.isNotBlank() } ?: defaultAgentId?.takeIf { it.isNotBlank() } ?: nativeString("OpenClaw")
}

internal fun overviewAgentBadgeText(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
): String {
  val agent = overviewAgent(agents = agents, defaultAgentId = defaultAgentId)
  agent
    ?.emoji
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?.let { return it }
  if (agent == null) return "OC"
  val source = agent.name?.takeIf { it.isNotBlank() } ?: agent.id.takeIf { it.isNotBlank() } ?: nativeString("OpenClaw")
  return agentInitials(source)
}

internal fun overviewAgentAvatar(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
): AgentAvatarSource? = overviewAgent(agents = agents, defaultAgentId = defaultAgentId)?.let(::agentAvatarSource)

private fun overviewAgent(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
): GatewayAgentSummary? {
  val defaultId = defaultAgentId?.trim().orEmpty()
  return if (defaultId.isBlank()) {
    agents.firstOrNull()
  } else {
    agents.firstOrNull { it.id == defaultId }
  }
}

private fun agentInitials(name: String): String =
  name
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { part -> localizedInitial(part, currentAppLanguage().languageTag) }
    .joinToString("")
    .ifBlank { "OC" }

private val sessionSourceLabels =
  mapOf(
    "cron" to "Cron",
    "discord" to "Discord",
    "guildchat" to "Guildchat",
    "imessage" to "iMessage",
    "matrix" to "Matrix",
    "slack" to "Slack",
    "telegram" to "Telegram",
    "whatsapp" to "WhatsApp",
    "workspace" to "Workspace",
  )

internal fun sessionSourceLabel(
  sessionKey: String,
  channelsSummary: GatewayChannelsSummary? = null,
): String {
  val normalized = sessionKey.trim()
  val scopedKey =
    if (normalized.startsWith("agent:", ignoreCase = true)) {
      normalized.substringAfter(':', missingDelimiterValue = "").substringAfter(':', missingDelimiterValue = "")
    } else {
      normalized
    }
  if (!scopedKey.contains(':') && !scopedKey.contains('#')) return nativeString("OpenClaw")
  val source = scopedKey.substringBefore(':').substringBefore('#').lowercase()
  val channelLabel =
    channelsSummary
      ?.channels
      ?.firstOrNull { channel ->
        channel.id.equals(source, ignoreCase = true)
      }?.label
      ?.takeIf { it.isNotBlank() }
  if (channelLabel != null) return channelLabel
  return nativeString(sessionSourceLabels[source] ?: "OpenClaw")
}

internal data class HomeAttentionRow(
  val title: String,
  val subtitle: String,
  val icon: ImageVector,
  val tab: Tab,
  val settingsRoute: SettingsRoute? = null,
  val danger: Boolean = false,
)

internal fun homeAttentionRows(
  isConnected: Boolean,
  pendingApprovals: Int,
  channelsSummary: GatewayChannelsSummary?,
  nodesDevicesSummary: GatewayNodesDevicesSummary,
  readyProviderCount: Int,
  unknownProviderCount: Int = 0,
  cronJobs: List<GatewayCronJobSummary> = emptyList(),
  nowMs: Long = System.currentTimeMillis(),
  gatewayWarning: String? = null,
): List<HomeAttentionRow> =
  listOfNotNull(
    if (!isConnected) {
      HomeAttentionRow(
        nativeString("Gateway"),
        nativeString("Connect before chat, voice, and live status."),
        Icons.Default.Cloud,
        Tab.Settings,
        SettingsRoute.Gateway,
        danger = true,
      )
    } else if (gatewayWarning != null) {
      HomeAttentionRow(nativeString("Gateway"), gatewayWarning, Icons.Default.Cloud, Tab.Settings, SettingsRoute.Gateway)
    } else {
      null
    },
    if (pendingApprovals > 0) {
      HomeAttentionRow(nativeString("Approvals"), approvalsSummary(pendingApprovals), Icons.Default.Lock, Tab.Settings, SettingsRoute.Approvals)
    } else {
      null
    },
    if (cronJobs.any { it.enabled && (it.lastRunStatus == "error" || (it.nextRunAtMs != null && it.nextRunAtMs < nowMs)) }) {
      HomeAttentionRow(nativeString("Automations"), nativeString("Failed or overdue runs"), Icons.Default.Notifications, Tab.Settings, SettingsRoute.CronJobs)
    } else {
      null
    },
    if (channelsSummary?.channels?.any { it.error != null } == true) {
      HomeAttentionRow(nativeString("Channels"), channelsSummaryText(channelsSummary), Icons.Default.Notifications, Tab.Settings, SettingsRoute.Channels)
    } else {
      null
    },
    if (nodesDevicesSummary.pendingDevices.isNotEmpty() || nodesDevicesSummary.hasNodeCapabilityApprovalPending()) {
      HomeAttentionRow(nativeString("Nodes & Devices"), nodesDevicesSummaryText(nodesDevicesSummary), Icons.Default.Cloud, Tab.Settings, SettingsRoute.NodesDevices)
    } else {
      null
    },
    if (isConnected && readyProviderCount == 0 && unknownProviderCount == 0) {
      HomeAttentionRow(nativeString("Providers"), nativeString("No ready providers"), Icons.Outlined.Inventory2, Tab.Settings, SettingsRoute.ProvidersModels)
    } else {
      null
    },
  )

internal data class RecentSessionListItem(
  val key: String,
  val title: String,
  val source: String,
  val metadata: String,
  val ownerAgentId: String? = null,
  val color: String? = null,
  val pinned: Boolean = false,
  val unread: Boolean = false,
)

internal fun overviewRecentSessionRows(
  sessions: List<ChatSessionEntry>,
  channelsSummary: GatewayChannelsSummary?,
): List<RecentSessionListItem> =
  sessions
    .map { session ->
      val title = sessionPresentationTitle(session) { nativeString("Main session") }
      RecentSessionListItem(
        key = session.key,
        ownerAgentId = session.ownerAgentId,
        color = session.color,
        pinned = session.pinned == true,
        unread = session.unread == true,
        title = title,
        source = sessionListSubtitle(session, sessionSourceLabel(session.key, channelsSummary)),
        metadata = (session.lastActivityAt ?: session.updatedAtMs)?.let(::relativeSessionTime) ?: "",
      )
    }

@Composable
private fun SettingsShellScreen(
  viewModel: MainViewModel,
  route: SettingsRoute,
  showSidebarButton: Boolean,
  onOpenSidebar: () -> Unit,
  onRouteChange: (SettingsRoute) -> Unit,
  onBack: () -> Unit,
  onOpenCommand: () -> Unit,
) {
  val displayName by viewModel.displayName.collectAsState()
  val gatewayConnectionDisplay by viewModel.gatewayConnectionDisplay.collectAsState()
  val isConnected = gatewayConnectionDisplay.isConnected
  val systemAgentChatState by viewModel.systemAgentChatState.collectAsState()
  val models by viewModel.providerModelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val notificationForwardingEnabled by viewModel.notificationForwardingEnabled.collectAsState()
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val agents by viewModel.gatewayAgents.collectAsState()
  val approvalInbox by viewModel.execApprovalInbox.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val cronStatus by viewModel.cronStatus.collectAsState()
  val usageState by viewModel.usageState.collectAsState()
  val usageSummary = usageState.summary
  val skillsState by viewModel.skillsState.collectAsState()
  val skillsSummary = skillsState.summary
  val skillWorkshopSummary by viewModel.skillWorkshopSummary.collectAsState()
  val nodesDevicesSummary by viewModel.nodesDevicesSummary.collectAsState()
  val channelsState by viewModel.channelsState.collectAsState()
  val channelsSummary = channelsState.summary
  val dreamingState by viewModel.dreamingState.collectAsState()
  val dreamingSummary = dreamingState.summary
  val desktopObserveAvailable by viewModel.desktopObserveAvailable.collectAsState()
  val appearanceThemeMode by viewModel.appearanceThemeMode.collectAsState()
  val providerRows = providerRows(providers = providers, models = models)
  val readyProviderCount = providerRows.count { it.ready }
  val unknownProviderCount = providerRows.count { it.availability == ProviderAvailability.Unknown }
  val pendingApprovalsCount = approvalInbox.approvals.size + pendingToolCalls.size

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshAgents()
      viewModel.refreshModelCatalog()
      viewModel.refreshProviderModels()
      viewModel.refreshCronJobs()
      viewModel.refreshUsage()
      viewModel.refreshSkills()
      viewModel.refreshSkillWorkshopProposals()
      viewModel.refreshNodesDevices()
      viewModel.refreshChannels()
      viewModel.refreshDreaming()
      viewModel.refreshExecApprovals()
    }
  }

  // System Back for settings routes is owned by the shell-level BackHandler, which
  // unwinds cross-tab opens to their originating tab via ShellNavigation. A local
  // BackHandler here would shadow it and strand cross-tab opens on Settings Home.
  if (route != SettingsRoute.Home) {
    SettingsDetailScreen(viewModel = viewModel, route = route, onBack = onBack)
    return
  }
  val appLanguage = currentAppLanguage()

  ClawScaffold(
    contentPadding =
      PaddingValues(
        start = ClawTheme.spacing.sm,
        top = ClawTheme.spacing.xxs,
        end = ClawTheme.spacing.sm,
        bottom = ClawTheme.spacing.xxxs,
      ),
    contentWindowInsets = shellContentInsets,
  ) {
    LazyColumn(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxs), contentPadding = PaddingValues(bottom = ClawTheme.spacing.xxxs)) {
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxs),
        ) {
          if (showSidebarButton) {
            ClawPlainIconButton(
              icon = Icons.Default.Menu,
              contentDescription = nativeString("Show Sidebar"),
              onClick = onOpenSidebar,
              modifier = Modifier.testTag("sidebar-open-settings"),
            )
          }
          Text(text = nativeString("Settings"), style = ClawTheme.type.display, color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          ClawPlainIconButton(
            icon = Icons.Default.Search,
            contentDescription = nativeString("Search settings"),
            onClick = onOpenCommand,
          )
        }
      }

      item {
        ProfilePanel(displayName = displayName.ifBlank { "OpenClaw" }, onClick = { onRouteChange(SettingsRoute.Profile) })
      }

      val settingsRows =
        listOf(
          SettingsRow(
            SettingsRoute.Gateway,
            verbatimText(gatewaySummary(gatewayConnectionDisplay)),
            status = gatewayConnectionDisplay.isConnected,
          ),
          SettingsRow(SettingsRoute.NodesDevices, verbatimText(nodesDevicesSummaryText(nodesDevicesSummary)), status = nodesDevicesStatus(nodesDevicesSummary)),
          SettingsRow(SettingsRoute.Channels, channelsState.summaryText(::channelsSummaryText), status = if (channelsState.errorText != null) false else channelsSummary?.let(::channelsStatus)),
          SettingsRow(SettingsRoute.Agents, if (agents.isEmpty()) nativeText("Load from gateway") else nativeText("\${agents.size} available", agents.size), status = agents.isNotEmpty()),
          SettingsRow(
            SettingsRoute.SystemAgent,
            nativeText("Setup, status, and repair"),
            status =
              when (systemAgentChatState.access) {
                SystemAgentChatAccess.Ready -> true
                SystemAgentChatAccess.CheckingGateway -> null
                else -> false
              },
          ),
          SettingsRow(
            SettingsRoute.ProvidersModels,
            when {
              readyProviderCount > 0 -> nativeText("\$readyProviderCount ready", readyProviderCount)
              unknownProviderCount > 0 -> nativeText("Availability unknown")
              else -> nativeText("Review readiness")
            },
            status =
              when {
                !isConnected -> false
                readyProviderCount > 0 -> true
                unknownProviderCount > 0 -> null
                else -> false
              },
          ),
          SettingsRow(SettingsRoute.Approvals, verbatimText(approvalsSummary(pendingApprovalsCount)), status = approvalsStatus(pendingApprovalsCount)),
          SettingsRow(SettingsRoute.CronJobs, verbatimText(cronJobsSummary(cronStatus.jobs)), status = if (cronStatus.jobs > 0) cronStatus.enabled else null),
          SettingsRow(SettingsRoute.Usage, usageState.summaryText { usageSummaryText(it.providers.size) }, status = if (usageState.errorText != null) false else true.takeIf { usageSummary?.providers?.isNotEmpty() == true }),
          SettingsRow(SettingsRoute.Skills, skillsState.summaryText { skillsSummaryText(it.skills) }, status = if (skillsState.errorText != null) false else skillsSummary?.skills?.let(::skillsStatus)),
          SettingsRow(
            SettingsRoute.SkillWorkshop,
            verbatimText(skillWorkshopSummaryText(skillWorkshopSummary)),
            status = skillWorkshopStatus(skillWorkshopSummary),
          ),
          SettingsRow(SettingsRoute.Dreaming, dreamingState.summaryText(::dreamingSummaryText), status = if (dreamingState.errorText != null) false else dreamingSummary?.let(::dreamingStatus)),
          SettingsRow(SettingsRoute.Terminal, nativeText("Shell in the agent workspace"), status = isConnected),
          SettingsRow(SettingsRoute.Desktop, nativeText("View a machine screen"), status = isConnected),
          SettingsRow(SettingsRoute.Voice, if (speakerEnabled) nativeText("Speaker on") else nativeText("Speaker muted")),
          SettingsRow(SettingsRoute.Notifications, if (notificationForwardingEnabled) nativeText("Smart delivery") else nativeText("Off")),
          SettingsRow(SettingsRoute.PhoneCapabilities, if (cameraEnabled) nativeText("Camera enabled") else nativeText("Locked"), status = !cameraEnabled),
          SettingsRow(
            SettingsRoute.Appearance,
            joinedNativeText(
              separator = " · ",
              parts = listOf(verbatimText(appearanceThemeSummary(appearanceThemeMode)), verbatimText(appLanguage.displayName)),
            ),
          ),
          SettingsRow(SettingsRoute.About, nativeText("Version and update")),
          SettingsRow(SettingsRoute.Health, nativeText("Diagnostics"), status = isConnected),
        ).filter { it.route.isAvailable(desktopObserveAvailable) }

      settingsSections(settingsRows).forEach { section ->
        item {
          SettingsSectionTitle(section.title)
        }
        item {
          SettingsGroup(rows = section.rows, onOpen = onRouteChange)
        }
      }

      item {
        SettingsSectionTitle(nativeText("Account"))
      }
      item {
        ClawPanel(contentPadding = PaddingValues(horizontal = ClawTheme.spacing.xs, vertical = ClawTheme.spacing.xxxs)) {
          SettingsListRow(
            title = nativeText("Sign Out"),
            value = nativeText("Return to setup"),
            icon = Icons.AutoMirrored.Filled.ExitToApp,
            opensRoute = false,
            onClick = viewModel::returnToGatewaySetup,
          )
        }
      }

      item {
        SettingsSectionTitle(nativeText("Licenses"))
      }
      item {
        SettingsGroup(
          rows = listOf(SettingsRow(SettingsRoute.Licenses, verbatimText(""))),
          onOpen = onRouteChange,
        )
      }

      item {
        Text(
          modifier = Modifier.fillMaxWidth().padding(top = ClawTheme.spacing.sm),
          text = nativeString("OpenClaw \${BuildConfig.VERSION_NAME} (\${BuildConfig.VERSION_CODE})", BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
          textAlign = TextAlign.Center,
        )
      }
    }
  }
}

private fun approvalsSummary(count: Int): String =
  when (count) {
    0 -> nativeString("No pending approvals")
    1 -> nativeString("1 pending")
    else -> nativeString("\$count pending", count)
  }

private fun approvalsStatus(count: Int): Boolean? = if (count > 0) true else null

/** Summarizes scheduled gateway jobs for overview and settings rows. */
private fun cronJobsSummary(count: Int): String =
  when (count) {
    0 -> nativeString("No scheduled jobs")
    1 -> nativeString("1 scheduled")
    else -> nativeString("\$count scheduled", count)
  }

private fun <T> GatewaySummaryState<T>.summaryText(format: (T) -> String): NativeText =
  errorText ?: summary?.let { verbatimText(format(it)) }
    ?: if (refreshing) nativeText("Refreshing") else nativeText("Load from gateway")

private fun usageSummaryText(count: Int): String =
  when (count) {
    0 -> nativeString("No provider usage")
    1 -> nativeString("1 provider")
    else -> nativeString("\$count providers", count)
  }

/** Reports how many gateway skills are enabled, eligible, and dependency-complete. */
private fun skillsSummaryText(skills: List<GatewaySkillSummary>): String {
  val ready =
    skills.count {
      !it.disabled && it.eligible && !it.blockedByAllowlist && !it.blockedByAgentFilter && it.missingCount == 0
    }
  return if (skills.isEmpty()) {
    nativeString("No skills")
  } else {
    nativeString("\$ready/\${skills.size} ready", ready, skills.size)
  }
}

/** Converts gateway skill health into a tri-state settings status dot. */
private fun skillsStatus(skills: List<GatewaySkillSummary>): Boolean? =
  when {
    skills.isEmpty() -> null

    skills.any {
      it.blockedByAllowlist ||
        it.blockedByAgentFilter ||
        (!it.disabled && (!it.eligible || it.missingCount > 0))
    } -> false

    else -> true
  }

/** Mirrors the Skill Workshop review queue in one compact Settings row. */
internal fun skillWorkshopSummaryText(summary: GatewaySkillWorkshopSummary): String {
  val pending = summary.proposals.count { it.status == "pending" }
  if (pending > 0) return if (pending == 1) nativeString("1 pending") else nativeString("\$pending pending", pending)
  val held = summary.proposals.count { it.status == "quarantined" || it.status == "stale" }
  val applied = summary.proposals.count { it.status == "applied" }
  return when {
    summary.proposals.isEmpty() -> nativeString("No proposals")
    held > 0 -> if (held == 1) nativeString("1 held") else nativeString("\$held held", held)
    applied > 0 -> if (applied == 1) nativeString("1 applied") else nativeString("\$applied applied", applied)
    else -> nativeString("\${summary.proposals.size} proposals", summary.proposals.size)
  }
}

internal fun skillWorkshopStatus(summary: GatewaySkillWorkshopSummary): Boolean? =
  when {
    summary.proposals.any { it.status == "pending" } -> false
    summary.proposals.any { it.status == "quarantined" || it.status == "stale" } -> false
    summary.proposals.any { it.status == "applied" } -> true
    else -> null
  }

/** Prioritizes pending pairings over online counts for compact node/device summaries. */
private fun nodesDevicesSummaryText(summary: GatewayNodesDevicesSummary): String {
  val online = summary.nodes.count { it.connected }
  val devices = summary.pairedDevices.size
  return when {
    summary.pendingDevices.isNotEmpty() -> nativeString("\${summary.pendingDevices.size} pending", summary.pendingDevices.size)
    summary.hasNodeCapabilityApprovalPending() -> nativeString("Node approval pending")
    summary.nodes.isNotEmpty() -> nativeString("\$online/\${summary.nodes.size} online", online, summary.nodes.size)
    devices > 0 -> nativeString("\$devices paired", devices)
    else -> nativeString("No devices")
  }
}

/** Maps node/device state to a settings status dot, treating pending pairings as attention-needed. */
private fun nodesDevicesStatus(summary: GatewayNodesDevicesSummary): Boolean? =
  when {
    summary.pendingDevices.isNotEmpty() -> false
    summary.hasNodeCapabilityApprovalPending() -> false
    summary.nodes.any { it.connected } -> true
    summary.pairedDevices.isNotEmpty() -> true
    else -> null
  }

private fun GatewayNodesDevicesSummary.hasNodeCapabilityApprovalPending(): Boolean =
  nodes.any { node ->
    node.approvalState is GatewayNodeCapabilityApproval.PendingApproval ||
      node.approvalState is GatewayNodeCapabilityApproval.PendingReapproval ||
      node.approvalState == GatewayNodeCapabilityApproval.Unapproved
  }

/** Summarizes channel connection state, surfacing errors before connected counts. */
internal fun channelsSummaryText(summary: GatewayChannelsSummary): String {
  val connected = summary.channels.count { it.connected }
  val issueCount = summary.channels.count { it.error != null }
  return when {
    issueCount == 1 -> nativeString("1 issue")
    issueCount > 1 -> nativeString("\$issueCount issues", issueCount)
    summary.channels.isNotEmpty() -> nativeString("\$connected/\${summary.channels.size} connected", connected, summary.channels.size)
    else -> nativeString("No channels")
  }
}

/** Maps channel health to the settings status dot shown in the shell. */
private fun channelsStatus(summary: GatewayChannelsSummary): Boolean? =
  when {
    summary.channels.any { it.error != null } -> false
    summary.channels.any { it.connected || it.running } -> true
    summary.channels.any { it.configured || it.linked } -> true
    else -> null
  }

/** Summarizes dreaming memory health before enabled/off state. */
private fun dreamingSummaryText(summary: GatewayDreamingSummary): String =
  when {
    !summary.storeHealthy || !summary.phaseSignalHealthy -> nativeString("Needs attention")
    summary.enabled -> nativeString("\${summary.shortTermCount} waiting", summary.shortTermCount)
    else -> nativeString("Off")
  }

/** Maps dreaming store/phase health and enabled state to a settings status dot. */
private fun dreamingStatus(summary: GatewayDreamingSummary): Boolean? =
  when {
    !summary.storeHealthy || !summary.phaseSignalHealthy -> false
    summary.enabled -> true
    else -> null
  }

internal data class SettingsRow(
  val route: SettingsRoute,
  val value: NativeText,
  val status: Boolean? = null,
)

internal data class SettingsSection(
  val title: NativeText,
  val rows: List<SettingsRow>,
)

internal fun settingsSections(rows: List<SettingsRow>): List<SettingsSection> =
  SettingsCategory.entries.mapNotNull { category ->
    val sectionRows = rows.filter { row -> row.route.category == category }
    if (sectionRows.isEmpty()) null else SettingsSection(title = category.title, rows = sectionRows)
  }

@Composable
private fun SettingsSectionTitle(title: NativeText) {
  val localizedTitle = title.resolveNativeTextResource()
  Text(
    text = localizedUppercase(localizedTitle, currentAppLanguage().languageTag),
    style = ClawTheme.type.caption,
    color = ClawTheme.colors.textMuted,
  )
}

@Composable
private fun ProfilePanel(
  displayName: String,
  onClick: () -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = ClawTheme.spacing.xs, vertical = ClawTheme.spacing.xxs)) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .clip(RoundedCornerShape(ClawTheme.radii.row))
          .clickable(onClick = onClick),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxs),
    ) {
      Surface(
        modifier = Modifier.size(32.dp),
        shape = CircleShape,
        color = ClawTheme.colors.surfacePressed,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Text(
            text =
              localizedInitial(displayName, currentAppLanguage().languageTag) ?: "O",
            style = ClawTheme.type.label,
            color = ClawTheme.colors.text,
            textAlign = TextAlign.Center,
          )
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxxs)) {
        Text(text = displayName, style = ClawTheme.type.section, color = ClawTheme.colors.text, maxLines = 1)
        Text(text = nativeString("OpenClaw mobile"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1)
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = nativeString("Open profile"),
        modifier = Modifier.size(15.dp),
        tint = ClawTheme.colors.text,
      )
    }
  }
}

@Composable
private fun SettingsGroup(
  rows: List<SettingsRow>,
  onOpen: (SettingsRoute) -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = ClawTheme.spacing.xs, vertical = ClawTheme.spacing.xxxs)) {
    ClawSeparatedColumn(items = rows) { row ->
      SettingsListRow(
        title = row.route.title,
        value = row.value,
        icon = row.route.icon,
        status = row.status,
        onClick = { onOpen(row.route) },
      )
    }
  }
}

@Composable
private fun SettingsListRow(
  title: NativeText,
  value: NativeText,
  icon: ImageVector,
  status: Boolean? = null,
  opensRoute: Boolean = true,
  onClick: () -> Unit,
) {
  val localizedTitle = title.resolveNativeTextResource()
  ClawListItem(
    title = localizedTitle,
    subtitle = value.resolveNativeTextResource().takeIf { it.isNotBlank() },
    leading = {
      Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(20.dp), tint = ClawTheme.colors.text)
    },
    trailing = {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxxs)) {
        status?.let { active ->
          Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(if (active) ClawTheme.colors.success else ClawTheme.colors.textSubtle))
        }
        Icon(
          imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
          contentDescription = settingsRowDisclosureDescription(localizedTitle, opensRoute = opensRoute),
          modifier = Modifier.size(17.dp),
          tint = ClawTheme.colors.text,
        )
      }
    },
    onClick = onClick,
  )
}

internal fun settingsRowDisclosureDescription(
  localizedTitle: String,
  opensRoute: Boolean,
): String = if (opensRoute) nativeString("Open \${row.title}", localizedTitle) else localizedTitle

internal fun gatewaySummary(
  statusText: String,
  isConnected: Boolean,
  gatewayConnectionProblem: GatewayConnectionProblem? = null,
): String {
  if (isConnected) return if (statusText == "Connected (node offline)") gatewayStatusForDisplay(statusText) else nativeString("Online and ready")
  val status = statusText.trim().lowercase()
  return when {
    status.contains("connecting") || status.contains("reconnecting") -> nativeString("Connecting...")
    status.contains("pairing") -> nativeString("Waiting for pairing")
    status.contains("auth") || status.contains("device identity") -> gatewayAuthRecoveryLabel(gatewayConnectionProblem) ?: nativeString("Authentication needed")
    status.contains("fingerprint verification timed out") -> nativeString("TLS timed out")
    status.contains("no tls endpoint") -> nativeString("No TLS endpoint")
    status.contains("certificate") || status.contains("tls") -> nativeString("Certificate review needed")
    else -> nativeString("Not connected")
  }
}

internal fun gatewaySummary(display: GatewayConnectionDisplay): String = gatewaySummary(display.statusText, display.isConnected, display.problem)
