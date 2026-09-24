package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.R
import ai.openclaw.app.chat.SESSION_LIST_FETCH_LIMIT
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.chat.rememberChatRealtimeTalkLauncher
import ai.openclaw.app.ui.design.AgentAvatarSource
import ai.openclaw.app.ui.design.ClawAgentAvatar
import ai.openclaw.app.ui.design.ClawListItem
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.OpenClawMascot
import ai.openclaw.app.ui.design.sessionColor
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.vectorResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** A compact overview in ordinary phone geometry; larger text and warnings remain scrollable. */
@Composable
internal fun OverviewScreen(
  viewModel: MainViewModel,
  showSidebarButton: Boolean,
  onOpenSidebar: () -> Unit,
  onSelectTab: (Tab) -> Unit,
  onOpenSettingsRoute: (SettingsRoute) -> Unit,
  onOpenCommand: () -> Unit,
) {
  val sessions by viewModel.chatSessions.collectAsState()
  val sessionCount by viewModel.chatSessionListCount.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val connection by viewModel.gatewayConnectionDisplay.collectAsState()
  val models by viewModel.providerModelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val approvalInbox by viewModel.execApprovalInbox.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val cronStatus by viewModel.cronStatus.collectAsState()
  val cronJobs by viewModel.cronJobs.collectAsState()
  val nodes by viewModel.nodesDevicesSummary.collectAsState()
  val channels by viewModel.channelsState.collectAsState()
  val agents by viewModel.gatewayAgents.collectAsState()
  val defaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()
  val selectedAgentId by viewModel.chatSessionOwnerAgentId.collectAsState()
  val agentId = selectedAgentId ?: defaultAgentId
  val providerRows = providerRows(providers, models)
  val approvals = approvalInbox.approvals.size + pendingToolCalls.size
  val attention =
    homeAttentionRows(
      isConnected = connection.isConnected,
      pendingApprovals = approvals,
      channelsSummary = channels.summary,
      nodesDevicesSummary = nodes,
      readyProviderCount = providerRows.count { it.ready },
      unknownProviderCount = providerRows.count { it.availability == ProviderAvailability.Unknown },
      cronJobs = cronJobs,
      gatewayWarning = gatewaySummary(connection).takeIf { connection.isConnected && (connection.problem != null || connection.statusText == "Connected (node offline)") },
    )
  val recent = overviewRecentSessions(sessions, mainSessionKey = viewModel.mainChatSessionKey(), agentId = agentId)
  val metrics = overviewMetricCardSpecs(nodes, pendingRunCount, cronStatus.jobs, approvals)
  val startTalk =
    rememberChatRealtimeTalkLauncher(viewModel) {
      // Permission/setup is resolved first. Selection and this capture share the exact Home target.
      viewModel.openMainChat(startTalk = true)
      onSelectTab(Tab.Chat)
    }
  LaunchedEffect(connection.isConnected, agentId) {
    if (connection.isConnected) {
      viewModel.refreshChatSessions(limit = SESSION_LIST_FETCH_LIMIT)
      viewModel.refreshAgents()
      viewModel.refreshModelCatalog()
      viewModel.refreshProviderModels()
      viewModel.refreshCronJobs()
      viewModel.refreshNodesDevices()
      viewModel.refreshChannels()
      viewModel.refreshExecApprovals()
      viewModel.refreshTalkSetupReadiness()
    }
  }
  ClawScaffold {
    BoxWithConstraints(Modifier.fillMaxSize()) {
      // Reserve normal controls first. Warnings reduce recents, never disappear to meet a height target.
      val rowBudget = ((maxHeight.value - 420f - attention.size * 64f) / (60f * LocalDensity.current.fontScale)).toInt().coerceIn(1, 5)
      val rows = overviewRecentSessionRows(recent.take(rowBudget), channels.summary)
      LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("overview-content"),
        verticalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxs),
        contentPadding = PaddingValues(bottom = ClawTheme.spacing.xxs),
      ) {
        item {
          Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (showSidebarButton) ClawPlainIconButton(webIcon(R.drawable.ic_web_menu), nativeString("Show Sidebar"), onOpenSidebar, Modifier.testTag("sidebar-open-overview"))
            OpenClawMascot(Modifier.size(25.dp))
            Text(nativeString("OpenClaw"), Modifier.weight(1f).padding(horizontal = 8.dp), style = ClawTheme.type.title, color = ClawTheme.colors.text)
            ClawPlainIconButton(webIcon(R.drawable.ic_web_search), nativeString("Search"), onOpenCommand)
          }
        }
        item {
          OverviewAgentHeader(
            name = overviewAgentName(agents, agentId),
            badge = overviewAgentBadgeText(agents, agentId),
            avatar = overviewAgentAvatar(agents, agentId),
            online = connection.isConnected,
            working = pendingRunCount > 0,
            onOpenAgent = { onOpenSettingsRoute(SettingsRoute.Agents) },
            onOpenGateway = { onOpenSettingsRoute(SettingsRoute.Gateway) },
          )
        }
        item {
          Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ClawPrimaryButton(
              text = nativeString("Home"),
              icon = webIcon(R.drawable.ic_web_home),
              modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
              onClick = {
                viewModel.openMainChat()
                onSelectTab(Tab.Chat)
              },
            )
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
              ClawSecondaryButton(nativeString("Talk"), startTalk, Modifier.weight(1f), icon = webIcon(R.drawable.ic_web_mic))
              ClawPlainIconButton(webIcon(R.drawable.ic_web_sliders_horizontal), nativeString("Talk settings"), { onOpenSettingsRoute(SettingsRoute.Voice) })
            }
          }
        }
        if (attention.isNotEmpty()) {
          item {
            OverviewAttention(attention) { row -> row.settingsRoute?.let(onOpenSettingsRoute) ?: onSelectTab(row.tab) }
          }
        }
        item {
          val columns = if (LocalDensity.current.fontScale > 1.3f) 2 else 4
          Column {
            metrics.chunked(columns).forEach { group ->
              Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                group.forEachIndexed { index, metric ->
                  if (index > 0) VerticalDivider(Modifier.height(48.dp), color = ClawTheme.colors.border)
                  OverviewMetric(metric, Modifier.weight(1f)) { metric.settingsRoute?.let(onOpenSettingsRoute) ?: onSelectTab(metric.tab) }
                }
              }
            }
          }
        }
        item {
          Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(nativeString("Recent sessions"), Modifier.weight(1f), style = ClawTheme.type.section, color = ClawTheme.colors.text)
            TextButton(onClick = { onSelectTab(Tab.Sessions) }) {
              val count = sessionCount?.takeIf { it.agentId == agentId && !it.archived }
              val label =
                when {
                  count == null || (count.isLowerBound && count.value == 0L) -> nativeString("See all")
                  count.isLowerBound -> nativeString("See all \$count+", count.value)
                  else -> nativeString("See all \$count", count.value)
                }
              Text(label, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
            }
          }
        }
        if (rows.isEmpty()) {
          item {
            Text(nativeString("No recent sessions"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted, modifier = Modifier.padding(vertical = 12.dp))
          }
        }
        rows.forEach { row ->
          item(key = row.ownerAgentId to row.key) {
            OverviewSessionRow(row) {
              viewModel.switchChatSession(row.key, row.ownerAgentId)
              onSelectTab(Tab.Chat)
            }
          }
        }
        item {
          HorizontalDivider(color = ClawTheme.colors.border)
          ClawListItem(
            title = nativeString("Files"),
            subtitle = nativeString("Agent workspace"),
            leading = { Icon(webIcon(R.drawable.ic_web_folder), null, tint = ClawTheme.colors.textMuted) },
            trailing = { Icon(webIcon(R.drawable.ic_web_chevron_right), null, tint = ClawTheme.colors.textMuted) },
            onClick = { onSelectTab(Tab.Files) },
            modifier = Modifier.testTag("overview-files"),
          )
        }
      }
    }
  }
}

@Composable
private fun webIcon(id: Int): ImageVector = ImageVector.vectorResource(id)

@Composable
private fun OverviewAgentHeader(
  name: String,
  badge: String,
  avatar: AgentAvatarSource?,
  online: Boolean,
  working: Boolean,
  onOpenAgent: () -> Unit,
  onOpenGateway: () -> Unit,
) {
  Row(Modifier.fillMaxWidth().clickable(onClick = onOpenAgent).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
    Box(Modifier.size(60.dp)) {
      ClawAgentAvatar(source = avatar, size = 60.dp) { Box(Modifier.fillMaxSize().clip(CircleShape).background(ClawTheme.colors.surfaceRaised), contentAlignment = Alignment.Center) { Text(badge, style = ClawTheme.type.title, color = ClawTheme.colors.text) } }
      Box(
        Modifier
          .align(Alignment.BottomEnd)
          .size(10.dp)
          .clip(CircleShape)
          .background(if (online) ClawTheme.colors.success else ClawTheme.colors.danger),
      )
    }
    Column(Modifier.weight(1f)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(name, Modifier.weight(1f), style = ClawTheme.type.display, color = ClawTheme.colors.text)
        Icon(webIcon(R.drawable.ic_web_chevron_right), nativeString("Open Agents"), tint = ClawTheme.colors.textMuted)
      }
      FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), itemVerticalAlignment = Alignment.CenterVertically) {
        Surface(onClick = onOpenGateway, modifier = Modifier.heightIn(min = 48.dp), shape = RoundedCornerShape(ClawTheme.radii.control), color = if (online) ClawTheme.colors.successSoft else ClawTheme.colors.dangerSoft) {
          Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(if (online) ClawTheme.colors.success else ClawTheme.colors.danger))
            Text(if (online) nativeString("Online") else nativeString("Offline"), style = ClawTheme.type.caption, color = ClawTheme.colors.text)
          }
        }
        if (online) {
          Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (working) {
              val pulse by rememberInfiniteTransition().animateFloat(
                initialValue = 0.45f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
              )
              Box(
                Modifier
                  .size(6.dp)
                  .graphicsLayer { alpha = pulse }
                  .clip(CircleShape)
                  .background(ClawTheme.colors.success),
              )
            }
            Text(if (working) nativeString("Working") else nativeString("Idle"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
          }
        }
      }
    }
  }
}

@Composable
private fun OverviewAttention(
  rows: List<HomeAttentionRow>,
  onOpen: (HomeAttentionRow) -> Unit,
) {
  Column(Modifier.fillMaxWidth().testTag("overview-attention"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(nativeString("Needs you"), style = ClawTheme.type.section, color = ClawTheme.colors.warning)
    rows.forEach { row ->
      val offline = row.danger
      Surface(color = if (offline) ClawTheme.colors.dangerSoft else ClawTheme.colors.warningSoft, shape = RoundedCornerShape(ClawTheme.radii.row)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          Icon(webIcon(if (offline) R.drawable.ic_web_globe_off else R.drawable.ic_web_shield_alert), null, Modifier.size(18.dp), tint = if (offline) ClawTheme.colors.danger else ClawTheme.colors.warning)
          Column(Modifier.weight(1f)) {
            Text(if (offline) nativeString("Can't reach your gateway") else row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text)
            if (!offline) Text(row.subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
          }
          TextButton(onClick = { onOpen(row) }, modifier = Modifier.semantics { contentDescription = row.title + ": " + row.subtitle }) {
            Text(
              if (offline) {
                nativeString("Reconnect")
              } else if (row.settingsRoute == SettingsRoute.CronJobs) {
                nativeString("Open")
              } else {
                nativeString("Review")
              },
              color = ClawTheme.colors.text,
              style = ClawTheme.type.label,
            )
          }
        }
      }
    }
  }
}

@Composable
private fun OverviewMetric(
  metric: OverviewMetricCardSpec,
  modifier: Modifier,
  onClick: () -> Unit,
) {
  val color =
    when (metric.status) {
      ClawStatus.Success -> ClawTheme.colors.success
      ClawStatus.Warning -> ClawTheme.colors.warning
      ClawStatus.Danger -> ClawTheme.colors.danger
      ClawStatus.Neutral -> ClawTheme.colors.text
    }
  Column(modifier.heightIn(min = 72.dp).clickable(onClick = onClick).padding(horizontal = 4.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(metric.value, style = ClawTheme.type.display, color = color)
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(metric.title, Modifier.weight(1f, fill = false), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      Icon(webIcon(R.drawable.ic_web_chevron_right), null, Modifier.size(12.dp), tint = ClawTheme.colors.textMuted)
    }
    metric.progressFraction?.let { progress ->
      Box(Modifier.fillMaxWidth().height(3.dp).background(ClawTheme.colors.surfacePressed)) {
        Box(Modifier.fillMaxWidth(progress.coerceIn(0f, 1f)).height(3.dp).background(color))
      }
    }
  }
}

@Composable
private fun OverviewSessionRow(
  row: RecentSessionListItem,
  onOpen: () -> Unit,
) {
  val tint = ClawTheme.colors.sessionColor(row.color) ?: ClawTheme.colors.textMuted
  Column {
    Row(
      Modifier
        .fillMaxWidth()
        .testTag("overview-recent-session")
        .heightIn(min = 52.dp)
        .clickable(onClick = onOpen)
        .padding(vertical = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Box(Modifier.size(40.dp).clip(RoundedCornerShape(ClawTheme.radii.row)).background(tint.copy(alpha = 0.12f)), contentAlignment = Alignment.Center) {
        Icon(webIcon(R.drawable.ic_web_message_square), null, Modifier.size(18.dp), tint = tint)
      }
      Column(Modifier.weight(1f)) {
        Text(row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(row.source, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      Column(horizontalAlignment = Alignment.End) {
        Text(row.metadata, style = ClawTheme.type.captionSmall, color = ClawTheme.colors.textMuted)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
          if (row.pinned) Icon(webIcon(R.drawable.ic_web_pin), nativeString("Pinned"), Modifier.size(14.dp), tint = ClawTheme.colors.textMuted)
          if (row.unread) {
            Box(
              Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(ClawTheme.colors.primary)
                .semantics { contentDescription = nativeString("Unread") },
            )
          }
        }
      }
    }
    HorizontalDivider(color = ClawTheme.colors.border)
  }
}
