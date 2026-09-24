package ai.openclaw.app.ui

import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.OpenClawMascot
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector

internal enum class SettingsCategory(
  val title: NativeText,
) {
  ThisDevice(nativeText("This device")),
  Connections(nativeText("Connections")),
  AgentsTools(nativeText("Agents & Tools")),
  PrivacySecurity(nativeText("Privacy & Security")),
  System(nativeText("System")),
}

internal enum class SettingsRoute(
  val title: NativeText,
  val icon: SettingsIcon,
  val category: SettingsCategory?,
) {
  Home(nativeText("Settings"), Icons.Outlined.Settings, null),
  Profile(nativeText("Profile"), Icons.Default.Person, null),
  Voice(nativeText("Talk"), Icons.Default.Mic, SettingsCategory.Connections),
  Agents(nativeText("Agents"), Icons.Default.Person, SettingsCategory.AgentsTools),
  ProvidersModels(nativeText("Models"), Icons.Outlined.Inventory2, SettingsCategory.AgentsTools),
  Approvals(nativeText("Approvals"), Icons.Default.Lock, SettingsCategory.PrivacySecurity),
  CronJobs(nativeText("Automations"), Icons.Outlined.AccessTime, SettingsCategory.AgentsTools),
  Usage(nativeText("Usage"), Icons.Default.Storage, SettingsCategory.AgentsTools),
  Skills(nativeText("Skills"), Icons.Default.Settings, SettingsCategory.AgentsTools),
  SkillWorkshop(nativeText("Skill Workshop"), Icons.Default.Settings, SettingsCategory.AgentsTools),
  SystemAgent(nativeText("OpenClaw"), SettingsIcon.OpenClaw, null),
  NodesDevices(nativeText("Devices"), Icons.Default.Cloud, SettingsCategory.Connections),
  Channels(nativeText("Channels"), Icons.Default.Notifications, SettingsCategory.Connections),
  Dreaming(nativeText("Dreaming"), Icons.Default.Storage, SettingsCategory.AgentsTools),
  Terminal(nativeText("Terminal"), Icons.Outlined.Terminal, SettingsCategory.AgentsTools),
  Desktop(nativeText("Desktop"), Icons.Outlined.DesktopWindows, SettingsCategory.AgentsTools),
  Notifications(nativeText("Notifications"), Icons.Default.Notifications, null),
  PhoneCapabilities(nativeText("Permissions"), Icons.Default.Lock, SettingsCategory.ThisDevice),
  Gateway(nativeText("Gateway"), Icons.Default.Cloud, SettingsCategory.Connections),
  Appearance(nativeText("Appearance"), Icons.Default.Palette, null),
  Health(nativeText("Health"), Icons.Default.Settings, SettingsCategory.System),
  About(nativeText("About"), Icons.Default.Storage, SettingsCategory.System),
  Licenses(nativeText("Licenses"), Icons.Default.Storage, SettingsCategory.System),
  ;

  constructor(title: NativeText, icon: ImageVector, category: SettingsCategory?) :
    this(title, SettingsIcon.Vector(icon), category)

  fun isAvailable(
    desktopObserveAvailable: Boolean,
    operatorAdminScopeAvailable: Boolean,
  ): Boolean =
    when (this) {
      Desktop -> desktopObserveAvailable
      SystemAgent -> operatorAdminScopeAvailable
      else -> true
    }
}

internal sealed interface SettingsIcon {
  data class Vector(
    val imageVector: ImageVector,
  ) : SettingsIcon

  data object OpenClaw : SettingsIcon
}

@Composable
internal fun SettingsIconContent(
  icon: SettingsIcon,
  modifier: Modifier = Modifier,
) {
  when (icon) {
    is SettingsIcon.Vector -> Icon(imageVector = icon.imageVector, contentDescription = null, modifier = modifier, tint = ClawTheme.colors.text)
    SettingsIcon.OpenClaw -> OpenClawMascot(modifier = modifier)
  }
}
