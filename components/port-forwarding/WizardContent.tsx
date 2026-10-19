/**
 * Port Forwarding Wizard Content
 * Renders step-by-step wizard content for creating port forwarding rules
 */
import { Check } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Host,PortForwardingRule,PortForwardingType } from '../../domain/models';
import { cn } from '../../lib/utils';
import { DistroAvatar } from '../DistroAvatar';
import { TrafficDiagram } from '../TrafficDiagram';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { getTypeDescription } from './utils';

export type WizardStep = 'type' | 'local-config' | 'remote-host-selection' | 'remote-config' | 'destination' | 'host-selection' | 'label';

export interface WizardContentProps {
    step: WizardStep;
    type: PortForwardingType;
    draft: Partial<PortForwardingRule>;
    hosts: Host[];
    onTypeChange: (type: PortForwardingType) => void;
    onDraftChange: (updates: Partial<PortForwardingRule>) => void;
    onOpenHostSelector: () => void;
}

export const WizardContent: React.FC<WizardContentProps> = ({
    step,
    type,
    draft,
    hosts,
    onTypeChange,
    onDraftChange,
    onOpenHostSelector,
}) => {
    const { t } = useI18n();
    const selectedHost = hosts.find(h => h.id === draft.hostId);

    switch (step) {
        case 'type':
            return (
                <>
                    <div className="text-sm font-medium mb-3">{t('pf.wizard.type.title')}</div>
                    <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60">
                        {(['local', 'remote', 'dynamic'] as PortForwardingType[]).map((pfType) => (
                            <Button
                                key={pfType}
                                variant={type === pfType ? 'default' : 'ghost'}
                                size="sm"
                                className={cn(
                                    "flex-1 h-9",
                                    type === pfType ? "bg-primary text-primary-foreground" : ""
                                )}
                                onClick={() => onTypeChange(pfType)}
                            >
                                {t(`pf.type.${pfType}`)}
                            </Button>
                        ))}
                    </div>

                    <div className="mt-6">
                        <TrafficDiagram type={type} isAnimating={true} />
                    </div>

                    <p className="text-sm text-muted-foreground mt-4 leading-relaxed">
                        {getTypeDescription(t, type)}
                    </p>
                </>
            );

        case 'local-config':
            return (
                <>
                    <div className="text-sm font-medium mb-3">{t('pf.wizard.localConfig.title')}</div>

                    <TrafficDiagram type={type} isAnimating={true} highlightRole="app" />

                    <p className="text-sm text-muted-foreground mt-2 mb-4 leading-relaxed">
                        {t('pf.wizard.localConfig.desc')}
                    </p>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label className="text-xs">{t('pf.wizard.localConfig.localPort')}</Label>
                            <Input
                                type="number"
                                placeholder={t('pf.wizard.placeholders.portExample', { port: 8080 })}
                                className="h-10"
                                value={draft.localPort || ''}
                                onChange={e => onDraftChange({ localPort: parseInt(e.target.value) || undefined })}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-xs">{t('pf.wizard.bindAddress')}</Label>
                            <Input
                                placeholder="127.0.0.1"
                                className="h-10"
                                value={draft.bindAddress || ''}
                                onChange={e => onDraftChange({ bindAddress: e.target.value })}
                            />
                        </div>
                    </div>
                </>
            );

        case 'remote-host-selection':
            return (
                <>
                    <div className="text-sm font-medium mb-3">{t('pf.wizard.remoteHost.title')}</div>

                    <TrafficDiagram type={type} isAnimating={true} highlightRole="ssh-server" />

                    <p className="text-sm text-muted-foreground mt-2 mb-4 leading-relaxed">
                        {t('pf.wizard.remoteHost.desc')}
                    </p>

                    <Button
                        variant="default"
                        className="w-full h-11"
                        onClick={onOpenHostSelector}
                    >
                        {selectedHost ? (
                            <div className="flex items-center gap-2 w-full">
                                <DistroAvatar
                                    host={selectedHost}
                                    fallback={(selectedHost.os || 'unknown').charAt(0).toUpperCase()}
                                    size="sm"
                                />
                                <span>{selectedHost.label}</span>
                                <Check size={14} className="ml-auto" />
                            </div>
                        ) : (
                            t('common.selectAHost')
                        )}
                    </Button>
                </>
            );

        case 'remote-config':
            return (
                <>
                    <div className="text-sm font-medium mb-3">{t('pf.wizard.remoteConfig.title')}</div>

                    <TrafficDiagram type={type} isAnimating={true} highlightRole="ssh-server" />

                    <p className="text-sm text-muted-foreground mt-2 mb-4 leading-relaxed">
                        {t('pf.wizard.remoteConfig.desc')}
                    </p>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label className="text-xs">{t('pf.wizard.remoteConfig.remotePort')}</Label>
                            <Input
                                type="number"
                                placeholder={t('pf.wizard.placeholders.portExample', { port: 8080 })}
                                className="h-10"
                                value={draft.localPort || ''}
                                onChange={e => onDraftChange({ localPort: parseInt(e.target.value) || undefined })}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-xs">{t('pf.wizard.bindAddress')}</Label>
                            <Input
                                placeholder="127.0.0.1"
                                className="h-10"
                                value={draft.bindAddress || ''}
                                onChange={e => onDraftChange({ bindAddress: e.target.value })}
                            />
                        </div>
                    </div>
                </>
            );

        case 'destination':
            return (
                <>
                    <div className="text-sm font-medium mb-3">{t('pf.wizard.destination.title')}</div>

                    <TrafficDiagram type={type} isAnimating={true} highlightRole="target" />

                    <p className="text-sm text-muted-foreground mt-2 mb-4 leading-relaxed">
                        {type === 'local'
                            ? t('pf.wizard.destination.desc.local')
                            : t('pf.wizard.destination.desc.remote')
                        }
                    </p>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label className="text-xs">{t('pf.wizard.destination.address')}</Label>
                            <Input
                                placeholder={t('pf.wizard.destination.addressPlaceholder')}
                                className="h-10"
                                value={draft.remoteHost || ''}
                                onChange={e => onDraftChange({ remoteHost: e.target.value })}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-xs">{t('pf.wizard.destination.port')}</Label>
                            <Input
                                type="number"
                                placeholder={t('pf.wizard.placeholders.portExample', { port: 3306 })}
                                className="h-10"
                                value={draft.remotePort || ''}
                                onChange={e => onDraftChange({ remotePort: parseInt(e.target.value) || undefined })}
                            />
                        </div>
                    </div>
                </>
            );

        case 'host-selection':
            return (
                <>
                    <div className="text-sm font-medium mb-3">{t('pf.wizard.sshServer.title')}</div>

                    <TrafficDiagram type={type} isAnimating={true} highlightRole="ssh-server" />

                    <p className="text-sm text-muted-foreground mt-2 mb-4 leading-relaxed">
                        {type === 'dynamic'
                            ? t('pf.wizard.sshServer.desc.dynamic')
                            : t('pf.wizard.sshServer.desc.default')
                        }
                    </p>

                    <Button
                        variant="default"
                        className="w-full h-11"
                        onClick={onOpenHostSelector}
                    >
                        {selectedHost ? (
                            <div className="flex items-center gap-2 w-full">
                                <DistroAvatar
                                    host={selectedHost}
                                    fallback={(selectedHost.os || 'unknown').charAt(0).toUpperCase()}
                                    size="sm"
                                />
                                <span>{selectedHost.label}</span>
                                <Check size={14} className="ml-auto" />
                            </div>
                        ) : (
                            t('common.selectAHost')
                        )}
                    </Button>

                    {/* Rule label */}
                    <div className="space-y-2 mt-6">
                        <Label className="text-xs">{t('field.label')}</Label>
                        <Input
                            placeholder={type === 'dynamic' ? t('pf.wizard.label.placeholder.dynamic') : t('pf.wizard.label.placeholder.default')}
                            className="h-10"
                            value={draft.label || ''}
                            onChange={e => onDraftChange({ label: e.target.value })}
                        />
                    </div>
                </>
            );

        case 'label':
            return (
                <>
                    <div className="text-sm font-medium mb-3">{t('pf.wizard.label.title')}</div>

                    <TrafficDiagram type={type} isAnimating={true} />

                    <div className="space-y-2 mt-4">
                        <Label className="text-xs">{t('field.label')}</Label>
                        <Input
                            placeholder={t('pf.wizard.label.placeholder.remoteRule')}
                            className="h-10"
                            value={draft.label || ''}
                            onChange={e => onDraftChange({ label: e.target.value })}
                        />
                    </div>
                </>
            );

        default:
            return null;
    }
};

export default WizardContent;
