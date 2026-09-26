import {
  ActionRowBuilder,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';

/**
 * Accent unique du bot, réutilisé par tous les embeds afin de garder une
 * identité visuelle cohérente entre les messages du bot et le portail web
 * (French-Squadron-Web/src/services/embeds.js doit rester synchronisé).
 */
export const BOT_ACCENT_COLOR = 0x475569;

export function createPermadeathNotificationEmbed(timestamp = new Date()) {
  return new EmbedBuilder()
    .setTitle('Tu es mort pendant une session roleplay !')
    .setDescription(
      'Ton personnage est désormais **mort de manière permanente**, si tu trouves cette mort injuste, alors ouvre un **ticket** afin de contester ta mort.\n\nLe Département de la Continuité de la FPCS'
    )
    .setColor(BOT_ACCENT_COLOR)
    .setFooter({ text: 'FPCS Utilities' })
    .setTimestamp(timestamp);
}

export function createSeparator(spacing = SeparatorSpacingSize.Small, divider = true) {
  return new SeparatorBuilder().setDivider(divider).setSpacing(spacing);
}

export function createV2Message({
  title,
  description,
  thumbnailUrl = null,
  sections = [],
  actionRow = null,
  footer = null,
  spacing = SeparatorSpacingSize.Small,
  accentColor = null,
  // New optional flag – when true the message will be visible only to the user who invoked the command
  ephemeral = false,
} = {}) {
  const container = new ContainerBuilder();

  if (accentColor !== null && accentColor !== undefined) {
    container.setAccentColor(accentColor);
  }

  if (title) {
    const cleanTitle = title.replace(/^◆\s*/, '').trim();
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${cleanTitle}`)
    );
  }

  if (thumbnailUrl && description) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(description))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl));
    container.addSectionComponents(section);
  } else if (description) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(description));
  }

  for (const sec of sections) {
    container.addSeparatorComponents(createSeparator(spacing, true));

    const content = typeof sec === 'string' ? sec : sec.content;
    const secThumbnail = typeof sec === 'object' && sec.thumbnailUrl ? sec.thumbnailUrl : null;

    if (secThumbnail && content) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(content))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(secThumbnail));
      container.addSectionComponents(section);
    } else if (content) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
    }
  }

  if (actionRow) {
    container.addSeparatorComponents(createSeparator(spacing, true));
    container.addActionRowComponents(actionRow);
  }

  if (footer) {
    container.addSeparatorComponents(createSeparator(SeparatorSpacingSize.Small, false));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`*${footer}*`));
  }

  return {
    components: [container],
    // Combine the base flag with Ephemeral when requested
    flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
  };
}

export function createV2EphemeralError(description, title = 'Permission insuffisante') {
  return {
    ...createV2Message({
      title,
      description,
    }),
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}
